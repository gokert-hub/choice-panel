# Rapechester CYOA for Lumiverse

A small Spindle extension for the Rapechester / Degrees of Lewdity roleplay setup.

## What it does

After Lumiverse finishes the main assistant reply, the extension makes one small **quiet LLM call** and generates 2–6 possible next actions.

The choices are **not appended to the assistant message**. They live in extension storage and are shown in a dedicated **Choices** drawer tab. Because of that, they do not become:
- roleplay canon,
- normal chat history,
- chat-memory chunks,
- Memory Cortex material.

Clicking a choice opens a Lumiverse edit/send dialog. You can edit the wording before sending it as the next user turn.

## Default settings

- Enabled: yes
- Choices: 4
- Preferred connection profile: `SPA main`
- Temperature: `0.55`
- Max output tokens: `180`
- Reasoning: forced OFF for the CYOA call

If `SPA main` does not exist, the extension falls back to the default connection profile. You can select another connection inside the **Choices** tab.

## Permissions

The extension asks for:
- `generation` — run the small post-generation CYOA call
- `chat_mutation` — send an edited selected option as a real user turn
- `chats` — detect the active chat

It does **not** modify assistant messages.

## Install

Lumiverse currently installs Spindle extensions from GitHub repositories.

1. Create a GitHub repository, for example `choice-panel`.
2. Put the contents of this folder at the repository root. `spindle.json` must be at the root.
3. Edit `spindle.json` and replace:
   - `https://github.com/gokert-hub/choice-panel`
   with your actual repository URL.
4. Commit/push the files.
5. In Lumiverse open **Extensions** and install the extension from the GitHub repository URL.
6. Grant the requested permissions.
7. Enable the extension.
8. Open a chat. A **Choices** drawer tab should appear.

The repository already contains `dist/backend.js` and `dist/frontend.js`, so Lumiverse does not need TypeScript or a build step to run it.

## Termux quick setup

After extracting the archive:

```sh
cd choice-panel

# Optional local syntax check
node --check dist/backend.js
node --check dist/frontend.js
```

Then upload the folder contents to your GitHub repo.

## How the CYOA prompt stays cheap

The extension sends only:
- the latest user turn,
- the completed assistant scene,
- a compact Orestes `<o_record>` state block if present.

It strips Orestes Ledger/Record markup from the prose copy and caps the text lengths before the secondary call.

## Notes

- On OOC/configuration responses, the CYOA model is instructed to return `NONE`.
- Regenerating choices is available from the Choices tab.
- Regenerating/swiping the main reply naturally creates a new set after the new generation completes.
- Choice suggestions are suggestions only. They are not treated as actions until you explicitly send one.
