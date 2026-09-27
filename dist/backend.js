// Rapechester CYOA — Spindle backend
// Uses only documented Lumiverse Spindle APIs.
// Choices are stored in extension user storage, never appended to assistant content.

const DEFAULT_CONFIG = {
  enabled: true,
  choiceCount: 4,
  connectionId: "",
  connectionName: "SPA main",
  temperature: 0.55,
  maxTokens: 180,
};

const processedGenerations = new Set();
const generatingChats = new Set();

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, Number(n)));
}

function safeFilePart(value) {
  return String(value || "").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function stripTag(text, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
  return String(text || "").replace(re, "").trim();
}

function extractTag(text, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = String(text || "").match(re);
  return m ? m[1].trim() : "";
}

function cleanScene(text) {
  let out = String(text || "");
  out = stripTag(out, "o_ledger");
  out = stripTag(out, "o_record");
  out = out.replace(/<o_scene\b[^>]*>/gi, "").replace(/<\/o_scene>/gi, "");
  out = out.replace(/<!--\s*VEIL:[\s\S]*?-->/gi, "");
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
    s = s.replace(/^[-*•]\s*/, "");
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
    choiceCount: clamp(cfg?.choiceCount ?? 4, 2, 6),
    temperature: clamp(cfg?.temperature ?? 0.55, 0, 2),
    maxTokens: clamp(cfg?.maxTokens ?? 180, 80, 400),
  };
}

async function saveConfig(config, userId) {
  await spindle.userStorage.setJson("config.json", config, {
    indent: 2,
    userId,
  });
}

async function statePath(chatId) {
  return `state/${safeFilePart(chatId)}.json`;
}

async function loadState(chatId, userId) {
  return spindle.userStorage.getJson(await statePath(chatId), {
    fallback: { chatId, messageId: "", choices: [], generatedAt: 0 },
    userId,
  });
}

async function saveState(chatId, state, userId) {
  await spindle.userStorage.setJson(await statePath(chatId), state, {
    indent: 2,
    userId,
  });
}

async function listConnections(userId) {
  try {
    const items = await spindle.connections.list(userId);
    return Array.isArray(items) ? items : [];
  } catch (err) {
    spindle.log.warn(`Rapechester CYOA: could not list connections: ${String(err)}`);
    return [];
  }
}

async function resolveConnection(config, userId) {
  const connections = await listConnections(userId);
  if (!connections.length) return { connection: null, connections };

  let connection = null;
  if (config.connectionId) {
    connection = connections.find((c) => c.id === config.connectionId) || null;
  }
  if (!connection && config.connectionName) {
    connection =
      connections.find((c) => String(c.name || "").toLowerCase() === String(config.connectionName).toLowerCase()) ||
      null;
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

async function generateChoices(chatId, messageId, assistantContent, userId) {
  if (!chatId || !assistantContent || generatingChats.has(chatId)) return;

  const config = await getConfig(userId);
  if (!config.enabled) return;

  generatingChats.add(chatId);
  try {
    const userTurn = await latestUserTurn(chatId);
    const scene = cleanScene(assistantContent);
    const record = extractTag(assistantContent, "o_record");

    // Avoid giant secondary prompts. We want the last beat, not the whole campaign.
    const clippedUser = userTurn.slice(-2200);
    const clippedScene = scene.slice(-6500);
    const clippedRecord = record.slice(-1800);

    const { connection } = await resolveConnection(config, userId);

    const system = `You are a post-generation CYOA option generator for a Rapechester / Degrees of Lewdity roleplay.

You receive the user's latest turn and the COMPLETED assistant scene.
Generate exactly ${config.choiceCount} concise possible NEXT actions for the user character.

Rules:
- The options are suggestions only. They have NOT happened.
- Never continue the story.
- Never write the user's thoughts, feelings, consent, involuntary reactions, or intentions as facts.
- Do not reveal hidden information or secrets the user character does not know.
- Do not invent access to unavailable locations, people, objects, abilities, or knowledge.
- Respect the physical position and immediate situation at the END of the assistant scene.
- Make options meaningfully different in approach, not paraphrases.
- At least one cautious, passive, observational, or exit option is welcome when contextually sensible.
- Preserve ambiguity.
- Match the language used by the roleplay scene.
- Do not summarize or explain.
- If the assistant response is OOC/configuration rather than roleplay, output exactly NONE.

Output ONLY numbered lines:
1. ...
2. ...
3. ...`;

    const user = [
      "LATEST USER TURN:",
      clippedUser || "(none)",
      "",
      "COMPLETED ASSISTANT SCENE:",
      clippedScene || "(none)",
      clippedRecord ? `\nCURRENT RECORD / STATE:\n${clippedRecord}` : "",
    ].join("\n");

    const request = {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      parameters: {
        temperature: config.temperature,
        top_p: 0.9,
        max_tokens: config.maxTokens,
      },
      reasoning: { source: "off" },
    };

    if (connection?.id) request.connection_id = connection.id;

    const result = await spindle.generate.quiet(request);
    const choices = parseChoices(result?.content, config.choiceCount);

    const state = {
      chatId,
      messageId: messageId || "",
      choices,
      generatedAt: Date.now(),
      connectionId: connection?.id || "",
      connectionName: connection?.name || "",
      model: connection?.model || "",
      usage: result?.usage || null,
    };

    await saveState(chatId, state, userId);
    spindle.sendToFrontend({ type: "cyoa_state", state }, userId);
  } catch (err) {
    spindle.log.error(`Rapechester CYOA generation failed: ${String(err)}`);
    spindle.sendToFrontend(
      { type: "cyoa_error", error: String(err?.message || err) },
      userId,
    );
  } finally {
    generatingChats.delete(chatId);
  }
}

spindle.on("GENERATION_ENDED", async (payload, userId) => {
  if (!payload || payload.error || !payload.chatId || !payload.messageId || !payload.content) return;
  if (processedGenerations.has(payload.generationId)) return;
  processedGenerations.add(payload.generationId);

  // Bound the dedupe set so a very long session doesn't grow forever.
  if (processedGenerations.size > 300) {
    const first = processedGenerations.values().next().value;
    if (first) processedGenerations.delete(first);
  }

  await generateChoices(
    payload.chatId,
    payload.messageId,
    payload.content,
    userId,
  );
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
        : { chatId: "", messageId: "", choices: [], generatedAt: 0 };

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
        choiceCount: clamp(msg.config?.choiceCount ?? current.choiceCount, 2, 6),
        connectionId: String(msg.config?.connectionId || ""),
        connectionName: String(msg.config?.connectionName || current.connectionName || "SPA main"),
        temperature: clamp(msg.config?.temperature ?? current.temperature, 0, 2),
        maxTokens: clamp(msg.config?.maxTokens ?? current.maxTokens, 80, 400),
      };
      await saveConfig(next, userId);
      spindle.toast.success("Rapechester CYOA settings saved.", userId);
      spindle.sendToFrontend({ type: "cyoa_config_saved", config: next }, userId);
      return;
    }

    if (msg.type === "regenerate_choices") {
      const active = await spindle.chats.getActive(userId);
      if (!active?.id) return;
      const messages = await spindle.chat.getMessages(active.id);
      const assistant = [...messages].reverse().find((m) => m.role === "assistant");
      if (!assistant) return;
      await generateChoices(active.id, assistant.id, assistant.content, userId);
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
        message: "Edit the action if you want, then send it as Nemie's next turn.",
        defaultValue: choice,
        multiline: true,
        submitLabel: "Send",
        cancelLabel: "Cancel",
        userId,
      });

      if (edited.cancelled || !edited.value?.trim()) return;

      await spindle.chat.appendMessage(
        chatId,
        {
          role: "user",
          content: edited.value.trim(),
          metadata: { source: "rapechester_cyoa" },
        },
        { triggerGeneration: true },
      );
      return;
    }
  } catch (err) {
    spindle.log.error(`Rapechester CYOA frontend request failed: ${String(err)}`);
    spindle.sendToFrontend(
      { type: "cyoa_error", error: String(err?.message || err) },
      userId,
    );
  }
});

spindle.log.info("Rapechester CYOA loaded.");
