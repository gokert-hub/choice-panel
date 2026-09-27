// Rapechester CYOA — Spindle frontend

export function setup(ctx) {
  let activeChatId = "";
  let currentState = { choices: [] };
  let config = {
    enabled: true,
    choiceCount: 4,
    connectionId: "",
    connectionName: "SPA main",
    temperature: 0.55,
    maxTokens: 180,
  };
  let connections = [];

  const removeStyle = ctx.dom.addStyle(`
    .rcyoa-wrap {
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .rcyoa-muted {
      color: var(--lumiverse-text-muted);
      font-size: 12px;
      line-height: 1.4;
    }
    .rcyoa-choice {
      width: 100%;
      text-align: left;
      padding: 11px 12px;
      margin: 0;
      border: 1px solid var(--lumiverse-border);
      border-radius: var(--lumiverse-radius);
      background: var(--lumiverse-fill-subtle);
      color: var(--lumiverse-text);
      cursor: pointer;
      line-height: 1.35;
    }
    .rcyoa-choice:active {
      transform: translateY(1px);
    }
    .rcyoa-row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
    }
    .rcyoa-btn {
      padding: 8px 10px;
      border: 1px solid var(--lumiverse-border);
      border-radius: var(--lumiverse-radius);
      background: var(--lumiverse-fill-subtle);
      color: var(--lumiverse-text);
      cursor: pointer;
    }
    .rcyoa-settings {
      border-top: 1px solid var(--lumiverse-border);
      padding-top: 12px;
      display: grid;
      gap: 9px;
    }
    .rcyoa-settings label {
      display: grid;
      gap: 4px;
      color: var(--lumiverse-text-muted);
      font-size: 12px;
    }
    .rcyoa-settings input,
    .rcyoa-settings select {
      width: 100%;
      box-sizing: border-box;
      padding: 8px 9px;
      border: 1px solid var(--lumiverse-border);
      border-radius: var(--lumiverse-radius);
      background: var(--lumiverse-fill-subtle);
      color: var(--lumiverse-text);
    }
    .rcyoa-title {
      font-weight: 650;
      color: var(--lumiverse-text);
    }
  `);

  const tab = ctx.ui.registerDrawerTab({
    id: "rapechester-cyoa",
    title: "Rapechester CYOA",
    shortName: "Choices",
    description: "Post-generation action choices for Rapechester roleplay",
    keywords: ["cyoa", "choices", "rapechester", "dol"],
    headerTitle: "Choices",
  });

  const action = ctx.ui.registerInputBarAction({
    id: "rapechester-cyoa-open",
    label: "Open CYOA choices",
    enabled: true,
  });

  action.onClick(() => tab.activate());

  const root = tab.root;
  root.innerHTML = `<div class="rcyoa-wrap"></div>`;
  const wrap = root.querySelector(".rcyoa-wrap");

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function render() {
    wrap.innerHTML = "";

    const title = el("div", "rcyoa-title", "Next actions");
    wrap.appendChild(title);

    if (!activeChatId) {
      wrap.appendChild(el("div", "rcyoa-muted", "Open a chat to use CYOA choices."));
    } else if (!config.enabled) {
      wrap.appendChild(el("div", "rcyoa-muted", "CYOA generation is disabled."));
    } else if (!currentState?.choices?.length) {
      wrap.appendChild(
        el(
          "div",
          "rcyoa-muted",
          "No choices yet. Generate a roleplay reply or tap Regenerate choices."
        )
      );
    } else {
      currentState.choices.forEach((choice, index) => {
        const button = el("button", "rcyoa-choice", `${index + 1}. ${choice}`);
        button.type = "button";
        button.addEventListener("click", () => {
          ctx.sendToBackend({
            type: "select_choice",
            chatId: activeChatId,
            choice,
          });
        });
        wrap.appendChild(button);
      });
    }

    const controls = el("div", "rcyoa-row");
    const regen = el("button", "rcyoa-btn", "↻ Regenerate choices");
    regen.type = "button";
    regen.disabled = !activeChatId || !config.enabled;
    regen.addEventListener("click", () => {
      ctx.sendToBackend({ type: "regenerate_choices" });
    });
    controls.appendChild(regen);
    wrap.appendChild(controls);

    const note = el(
      "div",
      "rcyoa-muted",
      "Choices are stored by the extension, not appended to the roleplay message, so they do not become chat canon or Memory Cortex material."
    );
    wrap.appendChild(note);

    const settings = el("div", "rcyoa-settings");

    const enabledLabel = el("label", "", "Enabled");
    const enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabled.checked = config.enabled !== false;
    enabledLabel.appendChild(enabled);
    settings.appendChild(enabledLabel);

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
    const auto = document.createElement("option");
    auto.value = "";
    auto.textContent = "Auto (prefer SPA main, then default)";
    conn.appendChild(auto);
    connections.forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = `${c.name} — ${c.model || c.provider || "model"}`;
      if (c.id === config.connectionId) opt.selected = true;
      conn.appendChild(opt);
    });
    connLabel.appendChild(conn);
    settings.appendChild(connLabel);

    const tempLabel = el("label", "", "Temperature");
    const temp = document.createElement("input");
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
    max.value = String(config.maxTokens ?? 180);
    maxLabel.appendChild(max);
    settings.appendChild(maxLabel);

    const save = el("button", "rcyoa-btn", "Save settings");
    save.type = "button";
    save.addEventListener("click", () => {
      ctx.sendToBackend({
        type: "save_config",
        config: {
          enabled: enabled.checked,
          choiceCount: Number(count.value || 4),
          connectionId: conn.value,
          connectionName: config.connectionName || "SPA main",
          temperature: Number(temp.value || 0.55),
          maxTokens: Number(max.value || 180),
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
      currentState = payload.state || { choices: [] };
      connections = Array.isArray(payload.connections) ? payload.connections : [];
      render();
      return;
    }

    if (payload.type === "cyoa_state") {
      currentState = payload.state || { choices: [] };
      if (currentState.chatId) activeChatId = currentState.chatId;
      render();
      return;
    }

    if (payload.type === "cyoa_config_saved") {
      config = { ...config, ...(payload.config || {}) };
      render();
      return;
    }

    if (payload.type === "cyoa_error") {
      ctx.log.error(`Rapechester CYOA: ${payload.error || "unknown error"}`);
    }
  });

  const unsubChat = ctx.events.on("CHAT_SWITCHED", (payload) => {
    activeChatId = payload?.chatId || "";
    currentState = { choices: [] };
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
