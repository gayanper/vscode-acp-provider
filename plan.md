# ACP VS Code Extension: User-Facing Fix Plan

## Context (Read First)

- Environment: Windows + PowerShell 5.2; use `bun` for installs and scripts.
- VS Code API guide (Language Model Chat Provider): https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider
- VS Code API types for chat (reference): https://github.com/microsoft/vscode/tree/main/src/vscode-dts
- ACP overview: https://agentclientprotocol.com/overview/introduction
- ACP protocol schema (message shapes/capabilities): https://agentclientprotocol.com/protocol/schema
- ACP reference repo (schema + examples): https://github.com/agentclientprotocol/agent-client-protocol
- Zed background: https://github.com/zed-industries/zed

Goal: make ACP-backed chat sessions reliable and predictable for end users (no silent failures, correct session behavior, complete rendering, and clear permission prompts) while staying aligned with VS Code’s Language Model Chat Provider APIs.

## Scope (User Impact Only)

- Prevent agent sessions from failing due to mismatched ACP capabilities.
- Ensure sessions behave like normal VS Code chat sessions: unique sessions, resumable history, stable URIs.
- Render all user-visible ACP output that users expect to see (text, links, tools, diffs, plans).
- Keep the UI responsive and accurate (progress, tool state, mode/model options).

Non-goals:

- Internal refactors that don’t change user-visible behavior.
- New features beyond what’s needed to make current flows correct.

## Milestone 0: Baseline + Regression Harness

- Add a repeatable manual checklist for Insiders:
  - Create new session, send prompt, cancel, reopen, resume.
  - Tool call: in-progress → completed, failed.
  - Permission request flow: allow/deny.
  - Mode/model picker: change, verify agent receives it.
- Extend `src/testScenarios.ts` to cover:
  - `resource_link` content rendering.
  - Multiple permission prompts in one turn.
  - Session commit from untitled → persisted.

## Milestone 1: Stop “Works On My Machine” Failures

### 1.1 Fix session storage compatibility

Problem: `node:sqlite` can prevent activation on some VS Code extension-host Node versions.

- Replace SQLite with a file-based store under `context.globalStorageUri` (JSON + atomic write).
- Keep schema equivalent: `{ agent_type, session_id, cwd, title, updated_at }`.
- Remove legacy SQLite migration to avoid maintaining dual storage paths in this in-development project.
  Files: `src/acpSessionDb.ts`.
  Acceptance:
- Extension activates and sessions list works on a clean VS Code Insiders install.

### 1.2 Make advertised ACP client capabilities match reality

Problem: agents will attempt `fs/*` and `terminal/*` when we claim support.
Choose one (prefer implementing minimal safe support):

- Option A (recommended): implement ACP client methods:
  - `fs/read_text_file` and `fs/write_text_file` via `vscode.workspace.fs`.
  - Constrain paths to the workspace (or explicitly configured roots).
  - Respect ACP `line`/`limit` semantics for reads.
  - `terminal/*`: implement as a managed process in the extension host (capture output deterministically). Optionally also offer “Run in Terminal” UX by mirroring the command to a VS Code terminal, but do not rely on terminal output APIs.
- Option B: set `CLIENT_CAPABILITIES` to `{ fs: { readTextFile: false, writeTextFile: false }, terminal: false }` until implemented.
  Files: `src/acpClient.ts`, `src/permittedPaths.ts`.
  Acceptance:
- Real ACP agents do not fail immediately when attempting file/terminal tools.
- Tool output appears in chat as the agent intended.

## Milestone 2: Session UX (The Core User Experience)

### 2.1 Fix “untitled session” identity + commit/migration

Problems:

- All untitled sessions collapse into a single logical session.
- `onDidCommitChatSessionItem` currently does not migrate to a new resource.
  Plan:
- Treat each untitled VS Code chat session resource as unique (no forced `sessionId = "untitled"`).
- When the first ACP session is created, commit the chat session item:
  - original resource: the untitled resource.
  - modified resource: stable resource derived from the ACP sessionId (e.g. `acp-<agent>:/<acpSessionId>`).
- Update in-memory maps so follow-up requests use the stable key.
  Files: `src/chatIdentifiers.ts`, `src/acpSessionManager.ts`, `src/acpChatSessionItemProvider.ts`.
  Acceptance:
- Starting two new chats yields two distinct sessions.
- Closing/reopening the session from the session picker resumes the correct history.

### 2.2 Stop agent restarts from disrupting sessions

Problem: switching between new/load modes can restart the agent process and lose context.
Plan:

- Avoid process restart when switching between session lifecycle operations.
- Prefer a single long-lived connection per agent instance, unless the protocol explicitly requires otherwise.
  Files: `src/acpClient.ts`.
  Acceptance:
- Creating a new session and then opening a previous session does not interrupt active sessions.

## Milestone 3: Render What Users Expect To See

### 3.1 Support ACP content beyond plain text

Problem: `resource_link` (and other non-text blocks) get dropped/warned.
Plan:

- When receiving `session/update` content blocks:
  - Render `resource_link` as a VS Code chat reference (preferred) or as Markdown link.
  - If `resource` is received, render a link + brief description (do not dump large binary content).
- Ensure history reconstruction (`TurnBuilder`) mirrors the same rendering.
  Files: `src/acpChatParticipant.ts`, `src/turnBuilder.ts`.
  Acceptance:
- Links/files sent by agents are clickable in live chat and after resume.

### 3.2 Tool invocations: correct final rendering

Problems:

- Completed tool calls in history use the wrong message field.
- Progress timers can show after completion.
  Plan:
- Use `pastTenseMessage` for completed tool invocations everywhere.
- Clear progress timers in `finally` and dispose cancellation sources.
  Files: `src/turnBuilder.ts`, `src/acpChatParticipant.ts`.
  Acceptance:
- Tool call UI shows correct completed state and does not “flicker” progress after completion.

## Milestone 4: Permission Prompts That Don’t Misfire

Problems:

- Prompt IDs collide; stale buttons can resolve the wrong prompt.
- Debug logging can throw.
  Plan:
- Generate unique prompt IDs (monotonic counter + sessionId + timestamp).
- Track prompts by `promptId` (map), validate both `promptId` and `sessionId` on resolve.
- Log only safe, serializable fields.
- Dispose the correct session context on unbind.
  Files: `src/permissionPrompts.ts`.
  Acceptance:
- Multiple prompts in the same session resolve correctly.
- Clicking an old button cannot resolve a new prompt.

## Milestone 5: Mode/Model Options Stay In Sync

Problems:

- Changes aren’t awaited; agent-driven updates are ignored.
  Plan:
- Await `changeMode` / `changeModel` calls and surface errors to the user.
- Handle `current_mode_update` and relevant option updates from ACP and reflect them via `onDidChangeChatSessionOptions`.
  Files: `src/acpChatSessionContentProvider.ts`, `src/acpChatParticipant.ts`.
  Acceptance:
- UI selection matches the actual agent mode/model after agent or user changes.

## Milestone 6: Settings Match What Users Configure

Problems:

- `title` vs `label` mismatch; wrong default type in configuration schema.
  Plan:
- Normalize on one property name for display label (pick `label`) across:
  - `package.json` configuration schema
  - docs (`README.md`)
  - runtime (`src/types.ts`, `src/agentRegistry.ts`)
- Remove `title` support to avoid redundant configuration paths during development.
- Ensure `acpClient.agents` default is a JSON object, not an array.
  Files: `package.json`, `README.md`, `src/types.ts`, `src/agentRegistry.ts`.
  Acceptance:
- A configured label shows up in the chat session picker.

## Validation (What to Run)

- `bun install`
- `bun run compile`
- Manual walkthrough in VS Code Insiders:
  - Start 2 new sessions, verify unique session IDs and titles.
  - Trigger tool call + permission prompt, allow and deny.
  - Verify `resource_link` is visible and clickable.
  - Resume a session from the picker and confirm history renders correctly.
