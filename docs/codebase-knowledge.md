# Codebase Knowledge: vscode-acp-provider

> Last updated: 2026-03-04  
> Generated from codebase exploration of `src/` directory.
> Reflects migration to VS Code engine `^1.110.0` and `ChatSessionItemController` API.

---

## Table of Contents

1. [ACP Client Lifecycle](#1-acp-client-lifecycle)
2. [Session Management](#2-session-management)
3. [Session Lifecycle Diagram](#3-session-lifecycle-diagram)
4. [Session ID Namespaces](#4-session-id-namespaces)
5. [Per-Session State Reference](#5-per-session-state-reference)
6. [Models, Mode & Options Pickers](#6-models-mode--options-pickers)
7. [VS Code Proposed APIs Used](#7-vs-code-proposed-apis-used)
8. [Key File Map](#8-key-file-map)

---

## 1. ACP Client Lifecycle

### Pattern: Lazy Initialization

The `AcpClientImpl` (`src/acpClient.ts`) is created eagerly but **connects lazily** — no subprocess is spawned at construction time.

### Creation Chain

```
extension.ts → activate()
  → registerAgents()
      → createAcpSessionManager(sessionDb, agent, ...)
          → clientFactory = () => createAcpClient(agent, permissionHandler, logger)
                                   → new AcpClientImpl(agent, ...)   // no process yet
```

### Lazy Boot: `ensureReady(expectedMode)`

- Called the first time `client.createSession()` or `client.loadSession()` is invoked.
- `ClientMode` is `"new_session" | "load_session"`. If the mode changes, the existing process is killed and restarted.
- Calls `createConnection(mode)` which:
  1. `ensureAgentRunning()` → `spawn(agent.command, args, { stdio: ['pipe','pipe','pipe'] })`
  2. Wraps stdin/stdout as Web Streams → `ndJsonStream()` (ACP ndjson framing from `@agentclientprotocol/sdk`)
  3. Constructs `new ClientSideConnection(() => this, stream)`
  4. Calls `connection.initialize({ protocolVersion, clientCapabilities, clientInfo })`
     - `clientInfo`: `{ name: "github-copilot-acp-client", version: "1.0.0" }`
     - `clientCapabilities`: `{ fs: { readTextFile: false, writeTextFile: false }, terminal: false }`
  5. Stores `initResponse.agentCapabilities` and fires `_onDidStart`

### Process Termination: `stopProcess()`

```typescript
agentProcess.kill(); // SIGTERM
await this.connection?.closed; // wait for graceful close
this.agentProcess = null;
this.connection = null;
this.readyPromise = null;
```

---

## 2. Session Management

### Entry Point: `SessionManager.createOrGet(resource)` — `src/acpSessionManager.ts`

Called by `AcpChatSessionContentProvider.provideChatSessionContent()`.

#### Path A — Untitled (new) session (`isUntitled === true`)

1. `clientFactory()` → new `AcpClientImpl`
2. Register subscriptions: `onSessionUpdate` → `handlePreChatSessionUpdate()`, `onDidOptionsChanged` → rebuild `cachedOptions`
3. `client.createSession(cwd, mcpServers)` → `ensureReady("new_session")` → spawn + ACP `newSession`
4. `new Session(agent, resource, client, acpSessionId, { modeId, modelId })` → stored in `activeSessions`
5. Fire `_onDidChangeSession`

#### Path B — Saved session (load from disk)

1. `clientFactory()` → new `AcpClientImpl`
2. Same subscriptions as Path A
3. `client.loadSession(sessionId, cwd, mcpServers)` → `ensureReady("load_session")` → `connection.loadSession()`
4. History reconstructed via `TurnBuilder` from returned `SessionNotification[]`
5. `new Session(...)` → stored in `activeSessions`

### Session Tracking — Two Layers

| Layer               | Location                                              | Key                          |
| ------------------- | ----------------------------------------------------- | ---------------------------- |
| In-memory (live)    | `SessionManager.activeSessions: Map<string, Session>` | decoded VS Code path segment |
| On-disk (persisted) | SQLite `acp-sessions.db` via `SessionDb`              | `(agent_type, session_id)`   |

SQLite path: `{context.globalStorageUri}/.acp/acp-sessions.db`

```sql
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_type TEXT NOT NULL,
  session_id TEXT NOT NULL,
  cwd TEXT,
  title TEXT,
  updated_at DATETIME NOT NULL,
  UNIQUE(agent_type, session_id)
);
```

### Session Closure

Triggered by `vscode.chat.onDidDisposeChatSession` (proposed API) in `extension.ts`:

```
→ SessionManager.closeSession(uri)
  → disposeSessionClient(sessionId, session)
      → cancellationSource.cancel()
      → event subscriptions disposed
      → session.client.dispose() → process.kill()
  → activeSessions.delete(sessionId)
```

### Additional `SessionManager` State

| Field                  | Type                                             | Description                            |
| ---------------------- | ------------------------------------------------ | -------------------------------------- |
| `activeSessions`       | `Map<string, Session>`                           | Live in-memory sessions                |
| `diskSessions`         | `Map<string, DiskSession> \| null`               | Lazy-loaded from SQLite                |
| `availableCommands`    | `Map<string, AvailableCommand[]>`                | Per ACP session ID                     |
| `sessionSubscriptions` | `Map<string, vscode.Disposable[]>`               | Per-session event subscriptions        |
| `cachedOptions`        | `Options { modes, models, thoughtLevelOptions }` | Rebuilt on each `_onDidOptionsChanged` |

---

## 3. Session Lifecycle Diagram

```
[VS Code opens chat panel]
         │
         ▼
AcpChatSessionContentProvider.provideChatSessionContent(resource)
         │
         ▼
SessionManager.createOrGet(resource)
         │
  ┌──────┴──────────────────────────────────────┐
  │ isUntitled = true                           │ isUntitled = false (saved)
  ▼                                             ▼
clientFactory() → new AcpClientImpl         clientFactory() → new AcpClientImpl
         │                                             │
         ▼                                             ▼
client.createSession(cwd, mcpServers)       client.loadSession(sessionId, cwd, mcpServers)
  → ensureReady("new_session")                → ensureReady("load_session")
  → spawn(agent.command)   ← PROCESS STARTS   → spawn(agent.command)
  → connection.initialize() ← ACP handshake   → connection.initialize()
  → connection.newSession() ← returns          → connection.loadSession() ← replays history
      { sessionId, modes, models,                       │
        configOptions }                        TurnBuilder.reconstructHistory()
         │                                             │
         └─────────────────────┬───────────────────────┘
                               ▼
              new Session(...) → activeSessions.set(key, session)
              session._status = InProgress

[User sends prompt]
         │
         ▼
AcpChatParticipant.handleRequest()
  → session.markAsInProgress()
  → session.pendingRequest = { cancellationSource }
  → client.prompt(sessionId, promptBlocks)
      → connection.prompt(...)    ← ACP prompt
      → streams SessionNotifications via onSessionUpdate
      → renderSessionUpdate()    ← writes to ChatResponseStream
   → session.markAsCompleted() / markAsFailed()
   → sessionManager.syncSessionState(resource, session)
       → _onDidChangeSession.fire()
       → LifecycledChatSessionItemController upserts to SQLite + updates items collection

[VS Code closes chat panel]
         │
         ▼
vscode.chat.onDidDisposeChatSession
  → sessionManager.closeSession(uri)
  → disposeSessionClient()
  → client.dispose() → process.kill()    ← PROCESS ENDS
  → activeSessions.delete(sessionId)
```

**Session Status transitions** (`ChatSessionStatus`):

- `InProgress = 2` — set in constructor and `markAsInProgress()`
- `Completed = 1` — set after successful prompt
- `Failed = 0` — set on error

---

## 4. Session ID Namespaces

Two distinct ID spaces coexist:

### ACP Session ID (agent-assigned)

- Returned by agent in `NewSessionResponse.sessionId` from `connection.newSession()`
- Stored in `Session.acpSessionId`
- Used in all ACP protocol calls: `prompt(sessionId, ...)`, `cancel(sessionId)`, `changeMode(sessionId, ...)`, etc.
- Persisted in SQLite as `session_id`

### VS Code Resource URI (extension-managed)

- Format: `acp-{agentId}:/{sessionId}` — e.g. `acp-opencode:/my-session-abc123`
- Created by `createSessionUri(agentId, sessionId)` in `src/chatIdentifiers.ts`
- Decoded by `decodeVscodeResource(resource)` → `{ isUntitled: boolean, sessionId: string }`
- **Untitled sessions**: path starts with `untitled-` → normalized to key `"untitled"`, so all untitled panes for an agent share the same in-memory slot
- Agent ID extracted via: `getAgentIdFromResource(resource)` → strips `acp-` prefix from URI scheme

---

## 5. Per-Session State Reference

### `Session` class — `src/acpSessionManager.ts`

| Field                | Type                                                | Description                                              |
| -------------------- | --------------------------------------------------- | -------------------------------------------------------- |
| `agent`              | `AgentRegistryEntry`                                | Agent config (command, args, env, id, label, mcpServers) |
| `vscodeResource`     | `vscode.Uri`                                        | The VS Code URI for this session                         |
| `client`             | `AcpClient`                                         | Live client with backing subprocess                      |
| `acpSessionId`       | `string`                                            | Agent-assigned ACP session ID                            |
| `defaultChatOptions` | `{ modeId, modelId }`                               | Mode/model at session creation                           |
| `cwd`                | `string`                                            | Working directory                                        |
| `_status`            | `ChatSessionStatus`                                 | `InProgress`, `Completed`, or `Failed`                   |
| `_title`             | `string`                                            | Display title (updated after first prompt)               |
| `_updatedAt`         | `number`                                            | `Date.now()` on last status change                       |
| `pendingRequest`     | `{ cancellation, permissionContext? } \| undefined` | In-flight request state                                  |

### `AcpClientImpl` internal cache — `src/acpClient.ts`

| Field                 | Source                             | Description                                  |
| --------------------- | ---------------------------------- | -------------------------------------------- |
| `supportedModelState` | `NewSessionResponse.models`        | Available models + current model ID          |
| `supportedModeState`  | `NewSessionResponse.modes`         | Available modes + current mode ID            |
| `configOptions`       | `NewSessionResponse.configOptions` | Agent-defined config (e.g. thought_level)    |
| `agentCapabilities`   | ACP `initialize` response          | Capabilities declared by the agent           |
| `agentProcess`        | `spawn()`                          | The running `ChildProcessWithoutNullStreams` |
| `connection`          | ACP SDK                            | The `ClientSideConnection`                   |
| `mode`                | `ClientMode`                       | `"new_session"` or `"load_session"`          |

---

## 6. Models, Mode & Options Pickers

All pickers use the **`chatSessionsProvider` proposed VS Code API** and are driven by the ACP agent.

### Data Source

All picker data comes from the ACP agent at session creation:

```
connection.newSession() / loadSession()
  └─ NewSessionResponse / LoadSessionResponse
        ├── .modes         → SessionModeState  { availableModes[], currentModeId }
        ├── .models        → SessionModelState { availableModels[], currentModelId }
        └── .configOptions → SessionConfigOption[]  (category: "thought_level")
```

### Build Pipeline

```
AcpClient.getSupportedModeState() / getSupportedModelState() / getConfigOptions()
         │
         ▼
SessionManager.buildOptions(client) → Options { modes, models, thoughtLevelOptions }
   → stored in cachedOptions
         │
         ▼
AcpChatSessionContentProvider.provideChatSessionProviderOptions()
   → buildOptionsGroup(options)
         │
         ▼
ChatSessionProviderOptions { optionGroups: ChatSessionProviderOptionGroup[] }
         │
         ▼
VS Code renders drop-down pickers in the chat session header
```

### Picker Group Definitions (`src/acpChatSessionContentProvider.ts → buildOptionsGroup()`)

**Mode picker** (`id: "mode"`)

```typescript
optionGroups.push({
  id: VscodeSessionOptions.Mode, // "mode"
  name: l10n.t("Mode"),
  items: modeState.availableModes.map((m) => ({
    id: m.id,
    name: m.name,
    description: m.description,
  })),
});
```

**Model picker** (`id: "model"`)

```typescript
optionGroups.push({
  id: VscodeSessionOptions.Model, // "model"
  name: l10n.t("Model"),
  items: modelState.availableModels.map((m) => ({
    id: m.modelId,
    name: m.name,
    description: m.description,
  })),
});
```

**Config options** (one group per `thought_level` option)

```typescript
for (const configOption of options.thoughtLevelOptions) {
  const flatOptions = configOption.options.filter((opt) => "value" in opt);
  optionGroups.push({
    id: configOption.id,
    name: l10n.t(configOption.name),
    items: flatOptions.map((opt) => ({ id: opt.value, name: opt.name })),
  });
}
```

Only flat `SessionConfigSelectOption` entries (those with a `value` field) are supported — grouped options are filtered out.

### Handling User Selections: `provideHandleOptionsChange(resource, updates)`

| User selects      | ACP call made                                                                     |
| ----------------- | --------------------------------------------------------------------------------- |
| New mode          | `connection.setSessionMode(sessionId, modeId)`                                    |
| New model         | `connection.unstable_setSessionModel(sessionId, modelId)` + re-sync configOptions |
| New thought level | `connection.setSessionConfigOption(sessionId, optionId, value)`                   |

After a **model change**, `AcpClientImpl.changeModel()` re-syncs `configOptions` because the new model may support different thought levels. If the new model has no `thought_level` support, stale options are filtered and `_onDidOptionsChanged` fires to trigger a full options rebuild.

### Runtime Updates: Agent → UI

**Agent-driven mode update** (e.g. after a slash command):

```
SessionNotification (type: current_mode_update)
  → AcpClientImpl updates supportedModeState.currentModeId
  → fires _onDidOptionsChanged
  → SessionManager.handlePreChatSessionUpdate()
  → fires _onDidCurrentModeChange({ resource, modeId })
  → AcpChatSessionContentProvider fires _onDidChangeChatSessionOptions:
      { resource, updates: [{ optionId: "mode", value: modeId }] }
  → VS Code updates the picker selection in the UI
```

**Options list rebuild** (e.g. after model change):

```
AcpClientImpl fires _onDidOptionsChanged
  → SessionManager updates cachedOptions
  → fires _onDidChangeOptions
  → AcpChatSessionContentProvider fires _onDidChangeChatSessionProviderOptions
  → VS Code re-calls provideChatSessionProviderOptions()
  → buildOptionsGroup() rebuilds all pickers
```

### Initial Values Set at Session Open

`provideChatSessionContent()` sets the initial selected values for all pickers:

```typescript
const session: vscode.ChatSession = {
  history: history || [],
  requestHandler: this.participant.requestHandler,
  options: {
    [VscodeSessionOptions.Mode]: acpSession.defaultChatOptions.modeId,
    [VscodeSessionOptions.Model]: acpSession.defaultChatOptions.modelId,
    ...buildThoughtLevelOptions(
      acpSession.client
        .getConfigOptions()
        .filter((o) => o.category === "thought_level"),
    ),
  },
};
```

### Option ID Constants — `src/types.ts`

```typescript
export const VscodeSessionOptions = {
  Mode: "mode",
  Model: "model",
  Agent: "agent",
};
```

---

## 7. VS Code Proposed APIs Used

| API                                                                           | File                                   | Purpose                                                                                                                                 |
| ----------------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `vscode.chat.registerChatSessionContentProvider(type, provider, participant)` | `extension.ts`                         | Registers picker provider and content provider per agent                                                                                |
| `vscode.chat.createChatSessionItemController(type, refreshHandler)`           | `acpChatSessionItemProvider.ts`        | Creates the session list sidebar controller per agent                                                                                   |
| `ChatSessionItemController.newChatSessionItemHandler`                         | `acpChatSessionItemProvider.ts`        | Called by VS Code when a new (untitled) session sends its first request; returns an initialised `ChatSessionItem` with the real ACP URI |
| `ChatSessionItemController.items` (collection)                                | `acpChatSessionItemProvider.ts`        | Managed set of `ChatSessionItem` objects, updated on session state changes                                                              |
| `vscode.chat.createChatParticipant(id, handler)`                              | `extension.ts`                         | Registers the chat participant                                                                                                          |
| `vscode.chat.onDidDisposeChatSession`                                         | `extension.ts`                         | Listens for panel close to kill agent process                                                                                           |
| `ChatSessionContentProvider.provideChatSessionContent()`                      | `acpChatSessionContentProvider.ts:52`  | Returns session history + initial option values + `title`                                                                               |
| `ChatSessionContentProvider.provideChatSessionProviderOptions()`              | `acpChatSessionContentProvider.ts:79`  | Returns available picker groups (mode, model, thought-level)                                                                            |
| `ChatSessionContentProvider.provideHandleOptionsChange()`                     | `acpChatSessionContentProvider.ts:158` | Handles user picker selections                                                                                                          |
| `onDidChangeChatSessionProviderOptions` event                                 | `acpChatSessionContentProvider.ts:46`  | Tells VS Code to re-query the full options list                                                                                         |
| `onDidChangeChatSessionOptions` event                                         | `acpChatSessionContentProvider.ts:41`  | Pushes a new current selection value to a picker                                                                                        |
| `vscode.lm.registerLanguageModelChatProvider("acp", ...)`                     | `extension.ts`                         | Stub model registration (required by VS Code)                                                                                           |
| `vscode.lm.invokeTool(VscodeGetConfirmation, ...)`                            | `permissionPrompts.ts`                 | In-chat permission confirmation UI                                                                                                      |
| `response.questionCarousel(questions, false)`                                 | `acpChatParticipant.ts`                | Interactive question UI in chat stream                                                                                                  |

Proposed API declarations are in the root-level `.d.ts` files:

- `vscode.proposed.chatSessionsProvider.d.ts` — the main pickers/sessions API
- `vscode.proposed.chatParticipantAdditions.d.ts`
- `vscode.proposed.chatParticipantPrivate.d.ts`
- `vscode.proposed.chatProvider.d.ts`
- `vscode.proposed.defaultChatParticipant.d.ts`

---

## 8. Key File Map

| File                                   | Responsibility                                                                                                                                |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/extension.ts`                     | Activation, agent registration, proposed API wiring                                                                                           |
| `src/acpClient.ts`                     | `AcpClientImpl` — process spawn, ACP protocol, model/mode/config state                                                                        |
| `src/acpSessionManager.ts`             | `SessionManager` + `Session` — session CRUD, caching, event routing                                                                           |
| `src/acpChatSessionContentProvider.ts` | `AcpChatSessionContentProvider` — VS Code picker integration                                                                                  |
| `src/acpChatSessionItemProvider.ts`    | `createAcpChatSessionItemController` + `LifecycledChatSessionItemController` — sidebar session list using `ChatSessionItemController` pattern |
| `src/acpChatParticipant.ts`            | `AcpChatParticipant` — prompt handling, streaming, tool calls                                                                                 |
| `src/acpSessionDb.ts`                  | `SqlLiteSessionDb` — SQLite persistence for sessions                                                                                          |
| `src/chatIdentifiers.ts`               | URI scheme helpers: `createSessionUri`, `decodeVscodeResource`                                                                                |
| `src/agentRegistry.ts`                 | `AgentRegistry` — reads agent config from VS Code settings                                                                                    |
| `src/permissionPrompts.ts`             | Permission/confirmation UI during tool invocations                                                                                            |
| `src/types.ts`                         | Shared types and `VscodeSessionOptions` constants                                                                                             |
| `src/turnBuilder.ts`                   | Reconstructs VS Code chat history turns from `SessionNotification[]`                                                                          |
| `src/testScenarios.ts`                 | Mock ACP client responses for extension tests                                                                                                 |
