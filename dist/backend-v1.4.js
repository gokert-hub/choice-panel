// Choice Panel CYOA backend v1.4
// Isolated post-generation choice generation using spindle.generate.raw.

const DEFAULT_CONFIG = {
  enabled: true,
  autoGenerate: true,
  choiceCount: 4,
  connectionId: "",
  connectionName: "",
  temperature: 0.55,
  maxTokens: 160,
};

const busyChats = new Set();
const seenGenerations = new Set();

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function safePart(value) {
  return String(value || "").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function statePath(chatId) {
  return "state/" + safePart(chatId) + ".json";
}

async function getConfig(userId) {
  const stored = await spindle.userStorage.getJson("config.json", {
    fallback: DEFAULT_CONFIG,
    userId,
  });
  return {
    ...DEFAULT_CONFIG,
    ...stored,
    enabled: stored?.enabled !== false,
    autoGenerate: stored?.autoGenerate !== false,
    choiceCount: clamp(stored?.choiceCount ?? 4, 2, 6),
    temperature: clamp(stored?.temperature ?? 0.55, 0, 2),
    maxTokens: clamp(stored?.maxTokens ?? 160, 80, 400),
  };
}

async function saveConfig(config, userId) {
  await spindle.userStorage.setJson("config.json", config, { indent: 2, userId });
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

function stripTag(text, tag) {
  const re = new RegExp("<" + tag + "\\b[^>]*>[\\s\\S]*?<\\/" + tag + ">", "gi");
  return String(text || "").replace(re, "");
}

function cleanScene(text) {
  let out = String(text || "");
  for (const tag of ["o_ledger", "o_record", "chorus_note", "o_card"]) {
    out = stripTag(out, tag);
  }
  out = out.replace(/<o_scene\b[^>]*>/gi, "").replace(/<\/o_scene>/gi, "");
  out = out.replace(/<!--\s*(?:VEIL|HIDDEN)\s*:[\s\S]*?-->/gi, "");
  return out.trim();
}

function parseChoices(text, count) {
  const raw = String(text || "").trim();
  if (!raw || /^NONE\b/i.test(raw)) return [];
  const result = [];
  for (const line of raw.split(/\r?\n/)) {
    let s = line.trim();
    if (!s) continue;
    s = s.replace(/^[-*]\s*/, "");
    s = s.replace(/^\d+\s*[.)\-:]\s*/, "");
    s = s.replace(/^Option\s+\d+\s*[:.)-]\s*/i, "");
    s = s.trim();
    if (!s || /^NONE$/i.test(s)) continue;
    if (!result.includes(s)) result.push(s);
    if (result.length >= count) break;
  }
  return result;
}

function systemPrompt(count) {
  return `You are a post-generation CYOA option generator for a roleplay scene.

Generate exactly ${count} concise possible NEXT actions for the player character after the completed assistant scene.

RULES:
1. Options are suggestions, not events. None has happened yet.
2. Do not continue the story or narrate outcomes, NPC reactions, consequences, success, or failure.
3. Preserve player agency. Never state the player's thoughts, feelings, consent, involuntary reactions, motives, or intentions as facts.
4. Use only available information. Do not reveal secrets, hidden lore, future events, private NPC motives, or facts the player character does not know.
5. Respect the end-of-scene physical state. Every option must be possible from the player's current location, access, possessions, abilities, injuries, and immediate circumstances.
6. Do not invent access. Never invent a room, route, key, item, person, clue, permission, skill, ability, or knowledge just to create an option.
7. Keep choices meaningfully different. Do not paraphrase the same action.
8. Diversify approaches only when context allows: cautious/observational, social, direct/risky, withdrawal/exit, waiting, investigation, or an already-established lead.
9. No correct choice. Do not imply one option is optimal, canonical, safer, smarter, or preferred.
10. Keep each option short. One short sentence preferred; two short sentences maximum.
11. Use action language, not internal monologue.
12. Match the language of the roleplay scene.
13. No meta commentary, summaries, labels, or probability estimates.
14. If the assistant response is OOC/configuration, an error message, or not a roleplay scene, output exactly NONE.

Output only numbered lines:
1. ...
2. ...
3. ...`;
}

async function listConnections(userId) {
  const connections = await spindle.connections.list(userId);
  return Array.isArray(connections) ? connections : [];
}

function looksFast(connection) {
  const text = (String(connection?.name || "") + " " + String(connection?.model || "")).toLowerCase();
  return /sidecar|fast|mini|flash|cheap|utility|small/.test(text);
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
      (c) => String(c.name || "").toLowerCase() === String(config.connectionName).toLowerCase()
    ) || null;
  }
  if (!connection) connection = connections.find(looksFast) || null;
  if (!connection) connection = connections.find((c) => c.is_default) || connections[0];
  return { connection, connections };
}

async function latestUserTurn(chatId) {
  const messages = await spindle.chat.getMessages(chatId);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") return String(messages[i].content || "");
  }
  return "";
}

async function callChoiceModel(request) {
  try {
    return await spindle.generate.raw(request);
  } catch (err) {
    const msg = String(err?.message || err);
    if (!/closed|upstream|network|stream|socket|timeout|temporary/i.test(msg)) throw err;
    spindle.log.warn("Choice Panel transient provider error; retrying once: " + msg);
    await new Promise((resolve) => setTimeout(resolve, 350));
    return spindle.generate.raw(request);
  }
}

async function generateChoices(chatId, messageId, assistantContent, userId, force = false) {
  if (!chatId || !assistantContent || busyChats.has(chatId)) return;

  const config = await getConfig(userId);
  if (!config.enabled) return;
  if (!force && !config.autoGenerate) return;

  busyChats.add(chatId);
  try {
    const userTurn = (await latestUserTurn(chatId)).slice(-2200);
    const scene = cleanScene(assistantContent).slice(-7000);
    const { connection } = await resolveConnection(config, userId);

    if (!connection?.id) {
      throw new Error("No usable LLM connection profile is available.");
    }

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
      userId,
      provider: connection.provider || "",
      model: connection.model || "",
      connection_id: connection.id,
      messages: [
        { role: "system", content: systemPrompt(config.choiceCount) },
        {
          role: "user",
          content: [
            "LATEST USER TURN:",
            userTurn || "(none)",
            "",
            "COMPLETED ASSISTANT SCENE:",
            scene || "(none)",
          ].join("\n"),
        },
      ],
      parameters: {
        temperature: config.temperature,
        top_p: 0.9,
        max_tokens: config.maxTokens,
      },
      reasoning: { source: "off" },
    };

    const result = await callChoiceModel(request);
    const choices = parseChoices(result?.content, config.choiceCount);

    const state = {
      chatId,
      messageId: messageId || "",
      choices,
      generatedAt: Date.now(),
      busy: false,
      connectionId: connection.id,
      connectionName: connection.name || "",
      model: connection.model || "",
      usage: result?.usage || null,
    };
    await saveState(chatId, state, userId);
    spindle.sendToFrontend({ type: "cyoa_state", state }, userId);
  } catch (err) {
    const error = String(err?.message || err);
    const state = {
      chatId,
      messageId: messageId || "",
      choices: [],
      generatedAt: Date.now(),
      busy: false,
      error,
    };
    await saveState(chatId, state, userId);
    spindle.sendToFrontend({ type: "cyoa_state", state }, userId);
    spindle.toast.warning("Choice Panel: " + error.slice(0, 220), userId);
    spindle.log.error("Choice Panel generation failed: " + error);
  } finally {
    busyChats.delete(chatId);
  }
}

async function sendUserTurn(chatId, text) {
  const value = String(text || "").trim();
  if (!chatId || !value) return;
  await spindle.chat.appendMessage(
    chatId,
    { role: "user", content: value, metadata: { source: "choice_panel_cyoa" } },
    { triggerGeneration: true }
  );
}

spindle.on("GENERATION_ENDED", async (payload, userId) => {
  if (!payload || payload.error || !payload.chatId || !payload.messageId || !payload.content) return;
  if (seenGenerations.has(payload.generationId)) return;
  seenGenerations.add(payload.generationId);
  if (seenGenerations.size > 300) {
    const first = seenGenerations.values().next().value;
    if (first) seenGenerations.delete(first);
  }
  await generateChoices(payload.chatId, payload.messageId, payload.content, userId, false);
});

spindle.onFrontendMessage(async (msg, userId) => {
  try {
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "get_state") {
      const active = await spindle.chats.getActive(userId);
      const config = await getConfig(userId);
      const resolved = await resolveConnection(config, userId);
      const state = active?.id
        ? await loadState(active.id, userId)
        : { chatId: "", messageId: "", choices: [], generatedAt: 0, busy: false };

      spindle.sendToFrontend({
        type: "cyoa_bootstrap",
        activeChatId: active?.id || "",
        config,
        state,
        connections: resolved.connections.map((c) => ({
          id: c.id,
          name: c.name,
          provider: c.provider,
          model: c.model,
          is_default: Boolean(c.is_default),
        })),
        resolvedConnectionId: resolved.connection?.id || "",
      }, userId);
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
      await generateChoices(active.id, assistant.id, assistant.content, userId, true);
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
        message: "Edit the action if you want. It is sent only after you press Send.",
        defaultValue: choice,
        multiline: true,
        submitLabel: "Send",
        cancelLabel: "Cancel",
        userId,
      });
      if (!edited.cancelled && edited.value?.trim()) {
        await sendUserTurn(chatId, edited.value);
      }
      return;
    }

    if (msg.type === "custom_choice") {
      const chatId = String(msg.chatId || "");
      if (!chatId) return;
      const custom = await spindle.prompt.input({
        title: "Custom action",
        message: "Write your own next action. It is sent only after you press Send.",
        defaultValue: "",
        multiline: true,
        submitLabel: "Send",
        cancelLabel: "Cancel",
        userId,
      });
      if (!custom.cancelled && custom.value?.trim()) {
        await sendUserTurn(chatId, custom.value);
      }
    }
  } catch (err) {
    const error = String(err?.message || err);
    spindle.log.error("Choice Panel frontend request failed: " + error);
    spindle.sendToFrontend({ type: "cyoa_error", error }, userId);
  }
});

spindle.log.info("Choice Panel CYOA backend v1.4 loaded.");
