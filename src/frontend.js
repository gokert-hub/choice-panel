// Choice Panel CYOA - Spindle frontend

export function setup(ctx) {
  let activeChatId = "";
  let currentState = { choices: [], busy: false };
  let config = {
    enabled: true,
    autoGenerate: true,
    choiceCount: 4,
    connectionId: "",
    connectionName: "",
    temperature: 0.55,
    maxTokens: 160,
  };
  let connections = [];
  let resolvedConnectionId = "";

  const removeStyle = ctx.dom.addStyle(`
    .cp-wrap {
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .cp-muted {
      color: var(--lumiverse-text-muted);
      font-size: 12px;
      line-height: 1.45;
    }
    .cp-title {
      font-weight: 650;
      color: var(--lumiverse-text);
    }
    .cp-choice {
      width: 100%;
      text-align: left;
      padding: 11px 12px;
      margin: 0;
      border: 1px solid var(--lumiverse-border);
      border-radius: var(--lumiverse-radius);
      background: var(--lumiverse-fill-subtle);
      color: var(--lumiverse-text);
      cursor: pointer;
      line-height: 1.4;
    }
    .cp-choice:active { transform: translateY(1px); }
    .cp-choice:disabled { opacity: 0.55; cursor: default; }
    .cp-row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
    }
    .cp-btn {
      padding: 8px 10px;
      border: 1px solid var(--lumiverse-border);
      border-radius: var(--lumiverse-radius);
      background: var(--lumiverse-fill-subtle);
      color: var(--lumiverse-text);
      cursor: pointer;
    }
    .cp-btn:disabled { opacity: 0.5; cursor: default; }
    .cp-settings {
      border-top: 1px solid var(--lumiverse-border);
      padding-top: 12px;
      display: grid;
      gap: 9px;
    }
    .cp-settings label {
      display: grid;
      gap: 4px;
      color: var(--lumiverse-text-muted);
      font-size: 12px;
    }
    .cp-settings input,
    .cp-settings select {
      width: 100%;
      box-sizing: border-box;
      padding: 8px 9px;
      border: 1px solid var(--lumiverse-border);
      border-radius: var(--lumiverse-radius);
      background: var(--lumiverse-fill-subtle);
      color: var(--lumiverse-text);
    }
    .cp-check {
      display: flex !important;
      grid-template-columns: none !important;
      align-items: center;
      gap: 8px !important;
    }
    .cp-check input { width: auto !important; }
  `);

  const tab = ctx.ui.registerDrawerTab({
    id: "choice-panel-cyoa",
    title: "Choice Panel CYOA",
    shortName: "Choices",
    description: "Post-generation CYOA choices for roleplay",
    keywords: ["cyoa", "choices", "roleplay"],
    headerTitle: "Choices",
  });

  const action = ctx.ui.registerInputBarAction({
    id: "choice-panel-open",
    label: "Open CYOA choices",
    enabled: true,
  });
  action.onClick(() => tab.activate());

  const root = tab.root;
  root.innerHTML = `<div class="cp-wrap"></div>`;
  const wrap = root.querySelector(".cp-wrap");

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function render() {
    wrap.innerHTML = "";
    wrap.appendChild(el("div", "cp-title", "Next actions"));

    if (!activeChatId) {
      wrap.appendChild(el("div", "cp-muted", "Open a chat to use CYOA choices."));
    } else if (!config.enabled) {
      wrap.appendChild(el("div", "cp-muted", "CYOA generation is disabled."));
    } else if (currentState?.busy) {
      wrap.appendChild(el("div", "cp-muted", "Generating choices..."));
    } else if (!currentState?.choices?.length) {
      const message = currentState?.error
        ? "Choice generation failed. Tap Regenerate choices to retry."
        : "No choices yet. Generate a roleplay reply or tap Regenerate choices.";
      wrap.appendChild(el("div", "cp-muted", message));
    } else {
      currentState.choices.forEach((choice, index) => {
        const button = el("button", "cp-choice", `${index + 1}. ${choice}`);
        button.type = "button";
        button.addEventListener("click", () => {
          ctx.sendToBackend({ type: "select_choice", chatId: activeChatId, choice });
        });
        wrap.appendChild(button);
      });
    }

    const controls = el("div", "cp-row");
    const regen = el("button", "cp-btn", "â» Regenerate choices");
    regen.type = "button";
    regen.disabled = !activeChatId || !config.enabled || !!currentState?.busy;
    regen.addEventListener("click", () => ctx.sendToBackend({ type: "regenerate_choices" }));
    controls.appendChild(regen);

    const custom = el("button", "cp-btn", "+ Custom action");
    custom.type = "button";
    custom.disabled = !activeChatId;
    custom.addEventListener("click", () => {
      ctx.sendToBackend({ type: "custom_choice", chatId: activeChatId });
    });
    controls.appendChild(custom);
    wrap.appendChild(controls);

    wrap.appendChild(
      el(
        "div",
        "cp-muted",
        "Choices stay outside the roleplay message and Memory Cortex. Selecting one opens an editable native dialog; it is sent only after you confirm.",
      ),
    );

    const settings = el("div", "cp-settings");

    const enabledLabel = el("label", "cp-check", "");
    const enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabled.checked = config.enabled !== false;
    enabledLabel.appendChild(enabled);
    enabledLabel.appendChild(document.createTextNode("Enabled"));
    settings.appendChild(enabledLabel);

    const autoLabel = el("label", "cp-check", "");
    const auto = document.createElement("input");
    auto.type = "checkbox";
    auto.checked = config.autoGenerate !== false;
    autoLabel.appendChild(auto);
    autoLabel.appendChild(document.createTextNode("Auto-generate after assistant replies"));
    settings.appendChild(autoLabel);

    const countLabel = el("label", "", "Choices");
    const count = document.createElement("input");
    count.type = "number";
    count.min = "2";
    count.max = "6";
    count.step = "1";
    count.value = String(config.choiceCount ?? 4);
    countLabel.appendChild(count);
    settings.appendChild(countLabel);

    const connLabel = el("label", "", "Connection profile");
    const conn = document.createElement("select");
    const autoConn = document.createElement("option");
    autoConn.value = "";
    autoConn.textContent = "Auto (prefer fast/sidecar, then default)";
    conn.appendChild(autoConn);
    connections.forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = `${c.name} - ${c.model || c.provider || "model"}`;
      if (c.id === config.connectionId) opt.selected = true;
      conn.appendChild(opt);
    });
    connLabel.appendChild(conn);
    settings.appendChild(connLabel);

    if (!config.connectionId && resolvedConnectionId) {
      const resolved = connections.find((c) => c.id === resolvedConnectionId);
      if (resolved) {
        settings.appendChild(
          el("div", "cp-muted", `Auto currently resolves to: ${resolved.name} - ${resolved.model || resolved.provider || "model"}`),
        );
      }
    }

    const tempLabel = el("label", "", "Temperature");
    const temp = document.createElement("input");
    temp.type = "number";
    temp.min = "0";
    temp.max = "2";
    temp.type = "number";
    temp.min = "0";
    temp.max = "2";
    temp.step = "0.05";
    temp.value = String(config.temperature ?? 0.55);
    tempLabel.appendChild(temp);
    settings.appendChild(tempLabel);

    const maxLabel = el("label", "", "Max output tokens");
    const max = document.createElement("input");
    max.type = "number";
    max.min = "80";
    max.max = "400";
    max.step = "10";
    max.value = String(config.maxTokens ?? 160);
    maxLabel.appendChild(max);
    settings.appendChild(maxLabel);

    const save = el("button", "cp-btn", "Save settings");
    save.type = "button";
    save.addEventListener("click", () => {
      ctx.sendToBackend({
        type: "save_config",
        config: {
          enabled: enabled.checked,
          autoGenerate: auto.checked,
          choiceCount: Number(count.value || 4),
          connectionId: conn.value,
          connectionName: "",
          temperature: Number(temp.value || 0.55),
          maxTokens: Number(max.value || 160),
        },
      });
    });
    settings.appendChild(save);

    wrap.appendChild(settings);
    tab.setBadge(currentState?.choices?.length ? String(currentState.choices.length) : null);
  }

  const unsubBackend = ctx.onBackendMessage((payload) => {
    if (!payload || typeof payload !== "object") return;

    if (payload.type === "cyoa_bootstrap") {
      activeChatId = payload.activeChatId || "";
      config = { ...config, ...(payload.config || {}) };
      currentState = payload.state || { choices: [], busy: false };
      connections = Array.isArray(payload.connections) ? payload.connections : [];
      resolvedConnectionId = payload.resolvedConnectionId || "";
      render();
      return;
    }

    if (payload.type === "cyoa_state") {
      currentState = payload.state || { choices: [], busy: false };
      if (currentState.chatId) activeChatId = currentState.chatId;
      render();
      return;
    }

    if (payload.type === "cyoa_config_saved") {
      config = { ...config, ...(payload.config || {}) };
      ctx.sendToBackend({ type: "get_state" });
      return;
    }

    if (payload.type === "cyoa_error") {
      ctx.log.error(`Choice Panel: ${payload.error || "unknown error"}`);
    }
  });

  const unsubChat = ctx.events.on("CHAT_SWITCHED", (payload) => {
    activeChatId = payload?.chatId || "";
    currentState = { choices: [], busy: false };
    render();
    ctx.sendToBackend({ type: "get_state" });
  });

  ctx.sendToBackend({ type: "get_state" });
  render();

  return () => {
    unsubBackend();
    unsubChat();
    action.destroy();
    tab.destroy();
    removeStyle();
  };
}
