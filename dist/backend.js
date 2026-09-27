// Choice Panel CYOA - Spindle backend
// Generates post-reply CYOA options without appending them to chat history.

const DEFAULT_CONFIG = {
  enabled: true,
  autoGenerate: true,
  choiceCount: 4,
  connectionId: "",
  connectionName: "",
  temperature: 0.55,
  maxTokens: 160,
};

const processedGenerations = new Set();
const generatingChats = new Set();

function clamp(n, min, max) {
  const value = Number(n);
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

function safeFilePart(value) {
  return String(value || "").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function stripTag(text, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
  return String(text || "").replace(re, "").trim();
}

function cleanScene(text) {
  let out = String(text || "");
  // Migration hygiene for older Orestes outputs.
  out = stripTag(out, "o_ledger");
  out = stripTag(out, "o_record");
  out = stripTag(out, "chorus_note");
  out = stripTag(out, "o_card");
  out = out.replace(/<o_scene\b[^>]*>/gi, "").replace(/<\/o_scene>/gi, "");
  out = out.replace(/<!--\s*(?:VEIL|HIDDEN)\s*:[\s\S]*?-->/gi, "");
  return out.trim();
}

function parseChoices(text, count) {
  const raw = String(text || "").trim();
  if (!raw || /^NONE\b/i.test(raw)) return [];

  const lines = raw.split(/\r?\n/);
  const result = [];
  for (const line of lines) {
    let s = line.trim();
    if (!s) continue;
    s = s.replace(/^[-**]\s*/, "");
    s = s.replace(/^\d+\s*[.)\-:]\s*/, "");
    s = s.replace(/^Option\s+\d+\s*[:.)-]\s*/i, "");
    s = s.trim();
    if (!s || /^NONE$/i.test(s)) continue;
    if (!result.includes(s)) result.push(s);
    if (result.length >= count) break;
  }
  return result;
}

async function getConfig(userId) {
  const cfg = await spindle.userStorage.getJson("config.json", {
    fallback: DEFAULT_CONFIG,
    userId,
  });
  return {
    ...DEFAULT_CONFIG,
    ...cfg,
    enabled: cfg?.enabled !== false,
    autoGenerate: cfg?.autoGenerate !== false,
    choiceCount: clamp(cfg?.choiceCount ?? 4, 2, 6),
    temperature: clamp(cfg?.temperature ?? 0.55, 0, 2),
    maxTokens: clamp(cfg?.maxTokens ?? 160, 80, 400),
  };
}

async function saveConfig(config, userId) {
  await spindle.userStorage.setJson("config.json", config, { indent: 2, userId });
}

function statePath(chatId) {
  return `state/${safeFilePart(chatId)}.json`;
}

async function loadState(chatId, userId) {
  return spindle.userStorage.getJson(statePath(chatId), {
    fallback: { chatId, messageId: "", choices: [], generatedAt: 0, busy: false },
    userId,
  });
}

async function saveState(chatId, state, userId) {
  await spindle.userStorage.setJson(statePath(chatId), state, { indent: 2, userId });
}

async function listConnections(userId) {
  try {
    const items = await spindle.connections.list(userId);
    return Array.isArray(items) ? items : [];
  } catch (err) {
    spindle.log.warn(`Choice Panel: could not list connections: ${String(err)}`);
    return [];
  }
}

function looksLikeFastUtilityConnection(connection) {
  const haystack = `${connection?.name || ""} ${connection?.model || ""}`.toLowerCase();
  return /sidecar|fast|mini|flash|cheap|utility|council|small/.test(haystack);
}

async function resolveConnection(config, userId) {
  const connections = await listConnections(userId);
  if (!connections.length) return { connection: null, connections };

  let connection = null;
  if (config.connectionId) {
    connection = connections.find((c) => c.id === config.connectionId) || null;
  }
  if (!connection && config.connectionName) {
    connection = connections.find(
      (c) => String(c.name || "").toLowerCase() === String(config.connectionName).toLowerCase(),
    ) || null;
  }
  if (!connection) {
    connection = connections.find(looksLikeFastUtilityConnection) || null;
  }
  if (!connection) {
    connection = connections.find((c) => c.is_default) || connections[0];
  }
  return { connection, connections };
}

async function latestUserTurn(chatId) {
  const messages = await spindle.chat.getMessages(chatId);
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return String(messages[i].content || "");
  }
  return "";
}

function cyoaSystemPrompt(choiceCount) {
  return `You are a post-generation CYOA option generator for a roleplay scene.

Your only job is to propose exactly ${choiceCount} concise possible NEXT actions for the player character after the completed assistant scene.

CYOA RULES:
1. OPTIONS ARE SUGGESTIONS, NOT EVENTS. None of them has happened yet.
2. DO NOT CONTINUE THE STORY. Do not narrate outcomes, NPC reactions, consequences, or success/failure after an option.
3. PRESERVE PLAYER AGENCY. Never state the player's thoughts, feelings, consent, involuntary reactions, motives, or intentions as facts.
4. USE ONLY AVAILABLE INFORMATION. Do not reveal secrets, hidden lore, future events, private NPC motives, or facts the player character does not know.
5. RESPECT THE END-OF-SCENE PHYSICAL STATE. Every option must be possible from the player's current location, access, possessions, abilities, injuries, and immediate circumstances.
6. DO NOT INVENT ACCESS. Never invent a room, route, key, item, person, clue, permission, skill, ability, or piece of knowledge just to create an option.
7. KEEP CHOICES MEANINGFULLY DIFFERENT. Do not produce paraphrases of the same action.
8. DIVERSIFY APPROACHES WHN CONTEXT ALLOWS. Useful categories include cautious/observational, social, direct/risky, withdrawal/exit, waiting, investigation, or pursuing an already-established lead. Do not force a category that makes no sense.
9. NO "CORRECT" CHOICE. Do not imply that one option is optimal, canonical, safer, smarter, or preferred.
10. KEEP EACH OPTION SHORT. One short sentence is preferred; two short sentences maximum.
11. USE ACTION LANGUAGE, NOT INTERNAL MONOLOGUE. Prefer "Ask Bailey where he was" over "Feel suspicious and wonder where Bailey was." Avoid writing quoted dialogue unless wording itself is essential.
12. MATCH THE LANGUAGE OF THE ROLEPLAY SCENE.
13. NO META COMMENTARY. No summaries, explanations, probability estimates, labels like "safe/risky", or notes to the user.
14. If the assistant response is OOC/configuration, an error message, or not a roleplay scene, output exactly NONE.

Output ONLY numbered lines, with no heading and no extra text:
1. ...
2. ...
3. ...`;
}

async function generateChoices(chatId, messageId, assistantContent, userId, { force = false } = {}) {
  if (!chatId || !assistantContent || generatingChats.has(chatId)) return;

  const config = await getConfig(userId);
  if (!config.enabled) return;
  if (!force && !config.autoGenerate) return;

  generatingChats.add(chatId);
  try {
    const userTurn = await latestUserTurn(chatId);
    const scene = cleanScene(assistantContent);
    const clippedUser = userTurn.slice(-2200);
    const clippedScene = scene.slice(-7000);
    const { connection } = await resolveConnection(config, userId);

    const busyState = {
      chatId,
      messageId: messageId || "",
      choices: [],
      generatedAt: Date.now(),
      busy: true,
    };
    await saveState(chatId, busyState, userId);
    spindle.sendToFrontend({ type: "cyoa_state", state: busyState }, userId);

    const request = {
      messages: [
        { role: "system", content: cyoaSystemPrompt(config.choiceCount) },
        {
          role: "user",
          content: [
            "LATEST USER TURN:",
            clippedUser || "(none)",
            "",
            "COMPLETED ASSISTANT SCENE:",
            clippedScene || "(none)",
          ].join("\n"),
        },
      ],
      parameters: {
        temperature: config.temperature,
        top_p: 0.9,
        max_tokens: config.maxTokens,
      },
      reasoning: { source: "off" },
      signal: AbortSignal.timeout(25000),
    };

    if (connection?.id) request.connection_id = connection.id;

    const result = await spindle.generate.quiet(request);
    const choices = parseChoices(result?.content, config.choiceCount);

    const state = {
      chatId,
      messageId: messageId || "",
      choices,
      generatedAt: Date.now(),
      busy: false,
      connectionId: connection?.id || "",
      connectionName: connection?.name || "",
      model: connection?.model || "",
      usage: result?.usage || null,
    };

    await saveState(chatId, state, userId);
    spindle.sendToFrontend({ type: "cyoa_state", state }, userId);
  } catch (err) {
    const state = {
      chatId,
      messageId: messageId || "",
      choices: [],
      generatedAt: Date.now(),
      busy: false,
      error: String(err?.message || err),
    };
    await saveState(chatId, state, userId);
    spindle.sendToFrontend({ type: "cyoa_state", state }, userId);
    spindle.toast.warning("Choice Panel could not generate options. You can retry from the Choices tab.", userId);
    spindle.log.error(`Choice Panel generation failed: ${String(err)}`);
  } finally {
    generatingChats.delete(chatId);
  }
}

async function submitUserTurn(chatId, text, userId) {
  const value = String(text || "").trim();
  if (!chatId || !value) return;
  await spindle.chat.appendMessage(
    chatId,
    {
      role: "user",
      content: value,
      metadata: { source: "choice_panel_cyoa" },
    },
    { triggerGeneration: true },
  );
}

spindle.on("GENERATION_ENDED", async (payload, userId) => {
  if (!payload || payload.error || !payload.chatId || !payload.messageId || !payload.content) return;
  if (processedGenerations.has(payload.generationId)) return;
  processedGenerations.add(payload.generationId);

  if (processedGenerations.size > 300) {
    const first = processedGenerations.values().next().value;
    if (first) processedGenerations.delete(first);
  }

  await generateChoices(payload.chatId, payload.messageId, payload.content, userId);
});

spindle.onFrontendMessage(async (msg, userId) => {
  try {
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "get_state") {
      const active = await spindle.chats.getActive(userId);
      const config = await getConfig(userId);
      const { connection, connections } = await resolveConnection(config, userId);
      const state = active?.id
        ? await loadState(active.id, userId)
        : { chatId: "", messageId: "", choices: [], generatedAt: 0, busy: false };

      spindle.sendToFrontend(
        {
          type: "cyoa_bootstrap",
          activeChatId: active?.id || "",
          config,
          state,
          connections: connections.map((c) => ({
            id: c.id,
            name: c.name,
            provider: c.provider,
            model: c.model,
            is_default: !!c.is_default,
          })),
          resolvedConnectionId: connection?.id || "",
        },
        userId,
      );
      return;
    }

    if (msg.type === "save_config") {
      const current = await getConfig(userId);
      const next = {
        ...current,
        enabled: msg.config?.enabled !== false,
        autoGenerate: msg.config?.autoGenerate !== false,
        choiceCount: clamp(msg.config?.choiceCount ?? current.choiceCount, 2, 6),
        connectionId: String(msg.config?.connectionId || ""),
        connectionName: String(msg.config?.connectionName || ""),
        temperature: clamp(msg.config?.temperature ?? current.temperature, 0, 2),
        maxTokens: clamp(msg.config?.maxTokens ?? current.maxTokens, 80, 400),
      };
      await saveConfig(next, userId);
      spindle.toast.success("Choice Panel settings saved.", userId);
      spindle.sendToFrontend({ type: "cyoa_config_saved", config: next }, userId);
      return;
    }

    if (msg.type === "regenerate_choices") {
      const active = await spindle.chats.getActive(userId);
      if (!active?.id) return;
      const messages = await spindle.chat.getMessages(active.id);
      const assistant = [...messages].reverse().find((m) => m.role === "assistant");
      if (!assistant) return;
      await generateChoices(active.id, assistant.id, assistant.content, userId, { force: true });
      return;
    }

    if (msg.type === "select_choice") {
      const chatId = String(msg.chatId || "");
      const choice = String(msg.choice || "").trim();
      if (!chatId || !choice) return;

      const state = await loadState(chatId, userId);
      if (!Array.isArray(state.choices) || !state.choices.includes(choice)) {
        spindle.toast.warning("That choice is stale. Regenerate choices first.", userId);
        return;
      }

      const edited = await spindle.prompt.input({
        title: "Use CYOA choice",
        message: "Edit the action if you want. It will be sent only after you press Send.",
        defaultValue: choice,
        multiline: true,
        submitLabel: "Send",
        cancelLabel: "Cancel",
        userId,
      });

      if (edited.cancelled || !edited.value?.trim()) return;
      await submitUserTurn(chatId, edited.value, userId);
      return;
    }

    if (msg.type === "custom_choice") {
      const chatId = String(msg.chatId || "");
      if (!chatId) return;

      const custom = await spindle.prompt.input({
        title: "Custom action",
        message: "Write your own next action. Nothing is sent until you press Send.",
        defaultValue: "",
        multiline: true,
        submitLabel: "Send",
        cancelLabel: "Cancel",
        userId,
      });

      if (custom.cancelled || !custom.value?.trim()) return;
      await submitUserTurn(chatId, custom.value, userId);
      return;
    }
  } catch (err) {
    spindle.log.error(`Choice Panel frontend request failed: ${String(err)}`);
    spindle.sendToFrontend(
      { type: "cyoa_error", error: String(err?.message || err) },
      userId,
    );
  }
});

spindle.log.info("Choice Panel CYOA loaded.");
