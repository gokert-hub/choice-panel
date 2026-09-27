# Choice Panel CYOA for Lumiverse

A small Spindle extension that generates **post-generation CYOA choices** after a roleplay reply.

## What it does

- Generates 2-6 concise next-action suggestions after the assistant finishes a roleplay scene.
- Keeps choices outside the assistant message, so they do not become chat canon or Memory Cortex material.
- Lets you choose a dedicated connection profile for the cheap secondary call.
- Prefers fast/sidecar-style connections automatically when no connection is selected.
- Uses reasoning OFF for the CYOA call.
- Lets you regenerate the current choices.
- Adds a **Custom action** button.
- Clicking a generated choice opens an editable native dialog and sends it only after confirmation.
- Skips OOC/configuration/error replies.

The full English generation rules are in [CYOA_RULES.md](CYOA_RULES.md).

## Recommended defaults

- Enabled: yes
- Auto-generate after assistant replies: yes
- Choices: 4
- Temperature: 0.55
- Max output tokens: 160
- Reasoning: off

For speed, select a small/fast model or the same cheap sidecar connection used by your Council tools.

## Permissions

The extension requests:

- `generation` - runs the small post-generation CYOA call
- `chat_mutation` - sends a selected/edited or custom action as a user turn
- `chats` - reads the active chat and recent messages

It does **not** rewrite assistant messages.

## Install / update

Install from:

`https://github.com/gokert-hub/choice-panel`

If already installed, use **Update** in Lumiverse Extensions, then **Restart** the extension.

## Notes

- Choices are suggestions only and have not happened until you send one.
- The model sees only the latest user turn and the completed assistant scene, keeping the secondary prompt relatively small.
- Old Orestes Ledger/Record/card markup is stripped before the CYOA call.
- If automatic generation fails, the Choices tab exposes a manual **Regenerate choices** action.
