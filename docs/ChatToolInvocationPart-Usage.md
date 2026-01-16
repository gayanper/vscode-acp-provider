# ChatToolInvocationPart Attributes Explained

## Overview

`ChatToolInvocationPart` represents a tool invocation in VS Code's chat UI. It displays progress, status, and results of tools being called by an AI agent. The part goes through various states and renders differently based on its attributes.

## State Machine

VS Code internally manages tool invocations through 6 states:

```
┌─────────────┐     ┌──────────────────────┐     ┌───────────┐
│  Streaming  │ ──► │ WaitingForConfirmation│ ──► │ Executing │
└─────────────┘     └──────────────────────┘     └───────────┘
                              │                        │
                              │                        ▼
                              │              ┌─────────────────────┐
                              │              │WaitingForPostApproval│
                              │              └─────────────────────┘
                              │                        │
                              ▼                        ▼
                        ┌───────────┐           ┌───────────┐
                        │ Cancelled │           │ Completed │
                        └───────────┘           └───────────┘
```

---

## Attribute Reference

### 1. `toolName: string` (Required)

**Purpose:** Identifies the tool being invoked.

**UI Effect:**

- Determines the **icon** displayed next to the tool invocation
- Provides the **display name** shown in the UI
- VS Code looks up tool metadata (description, icon) using this name

**Example:**

```typescript
const part = new vscode.ChatToolInvocationPart(
  "file_read", // toolName - shows "Read File" with file icon
  "call-123",
);
```

---

### 2. `toolCallId: string` (Required)

**Purpose:** Unique identifier for this specific tool call.

**UI Effect:**

- Used internally for **matching/diffing** parts during re-renders
- Enables **streaming updates** - VS Code correlates `beginToolInvocation`, `updateToolInvocation`, and the final `ChatToolInvocationPart` using this ID
- Links the tool call to its result

**Example:**

```typescript
// Start streaming
response.beginToolInvocation("call-456", "bash");

// Later, push the completed part with same ID
const part = new vscode.ChatToolInvocationPart("bash", "call-456");
part.isComplete = true;
response.push(part);
```

---

### 3. `isError?: boolean`

**Purpose:** Indicates whether the tool invocation failed.

**UI Effect:**

| Value                  | Icon                                                  | Color                 |
| ---------------------- | ----------------------------------------------------- | --------------------- |
| `undefined` or `false` | ✓ Checkmark (when complete) or spinner (when running) | Normal                |
| `true`                 | ✗ Error icon                                          | Red/Error theme color |

**Example:**

```typescript
const part = new vscode.ChatToolInvocationPart("bash", "call-789", true);
part.isComplete = true;
part.pastTenseMessage = "Command failed with exit code 1";
response.push(part);
```

---

### 4. `invocationMessage?: string | MarkdownString`

**Purpose:** Progress message shown **while the tool is executing**.

**UI Effect:**

- Displayed as the **primary text** during tool execution
- Typically describes what the tool is doing
- Can include Markdown formatting

**Example:**

```typescript
const part = new vscode.ChatToolInvocationPart("file_write", "call-101");
part.invocationMessage = "Writing to `config.json`...";
response.push(part);
```

**Rendered as:**

```
⏳ Writing to `config.json`...
```

---

### 5. `originMessage?: string | MarkdownString`

**Purpose:** Subtitle text shown in **confirmation dialogs**.

**UI Effect:**

- Appears as secondary/subtitle text when user approval is needed
- Provides additional context about why the tool needs to run
- Only visible during the `WaitingForConfirmation` state

**Example:**

```typescript
const part = new vscode.ChatToolInvocationPart("terminal_run", "call-102");
part.invocationMessage = "Run `npm install`";
part.originMessage = "Install dependencies for the project";
part.isConfirmed = false; // Triggers confirmation dialog
```

---

### 6. `pastTenseMessage?: string | MarkdownString`

**Purpose:** Message shown **after the tool completes**.

**UI Effect:**

- **Replaces** `invocationMessage` once `isComplete = true`
- Typically describes what the tool did (past tense)
- Remains visible in chat history

**Example:**

```typescript
const part = new vscode.ChatToolInvocationPart("file_read", "call-103");
part.isComplete = true;
part.pastTenseMessage = "Read 150 lines from `src/index.ts`";
response.push(part);
```

**Rendered as:**

```
✓ Read 150 lines from `src/index.ts`
```

---

### 7. `isConfirmed?: boolean`

**Purpose:** Controls whether user confirmation is required/given.

**UI Effect:**

| Value       | Behavior                                               |
| ----------- | ------------------------------------------------------ |
| `undefined` | Tool runs without asking (auto-confirmed)              |
| `false`     | Shows **confirmation dialog** with Accept/Deny buttons |
| `true`      | User approved; shows checkmark when complete           |

**Example:**

```typescript
// Tool requiring user confirmation
const part = new vscode.ChatToolInvocationPart("file_delete", "call-104");
part.invocationMessage = "Delete `temp.log`?";
part.isConfirmed = false; // Shows confirmation UI
response.push(part);

// After user clicks "Accept"
part.isConfirmed = true;
part.isComplete = true;
part.pastTenseMessage = "Deleted `temp.log`";
response.push(part);
```

---

### 8. `isComplete?: boolean`

**Purpose:** Indicates whether the tool invocation has finished.

**UI Effect:**

| Value                  | Icon                                  | Message Shown       |
| ---------------------- | ------------------------------------- | ------------------- |
| `undefined` or `false` | Spinner ⏳                            | `invocationMessage` |
| `true`                 | Checkmark ✓ (or error ✗ if `isError`) | `pastTenseMessage`  |

**Example:**

```typescript
const part = new vscode.ChatToolInvocationPart("search", "call-105");

// While running
part.invocationMessage = "Searching codebase...";
part.isComplete = false;
response.push(part);

// When done
part.isComplete = true;
part.pastTenseMessage = "Found 23 matches";
response.push(part);
```

---

### 9. `toolSpecificData?: ChatTerminalToolInvocationData`

**Purpose:** Enables **specialized UI** for specific tool types.

**UI Effect:**

- For **terminal tools**: Shows an inline terminal-like UI with the command
- Displays editable command line with original, user-edited, and tool-edited versions
- Enables "Run in Terminal" button

**Structure:**

```typescript
interface ChatTerminalToolInvocationData {
  commandLine: {
    original: string; // Original command from AI
    userEdited?: string; // User's modifications
    toolEdited?: string; // Tool's modifications
  };
  language: string; // Shell language (bash, powershell, etc.)
}
```

**Example:**

```typescript
const part = new vscode.ChatToolInvocationPart("terminal_run", "call-106");
part.toolSpecificData = {
  commandLine: {
    original: "npm install lodash",
    userEdited: "npm install lodash@4.17.21", // User modified version
  },
  language: "bash",
};
response.push(part);
```

**Rendered as:**

```
┌─────────────────────────────────────┐
│ $ npm install lodash@4.17.21        │
│                        [Run] [Edit] │
└─────────────────────────────────────┘
```

---

### 10. `subAgentInvocationId?: string`

**Purpose:** Groups multiple tool calls under a **collapsible sub-agent section**.

**UI Effect:**

- Tools with the same `subAgentInvocationId` are grouped together
- Creates a collapsible accordion-style UI
- Shows the sub-agent's name/icon as the header
- Useful when delegating to another agent that makes multiple tool calls

**Example:**

```typescript
// Multiple tools from a sub-agent
const tool1 = new vscode.ChatToolInvocationPart("read_file", "call-201");
tool1.subAgentInvocationId = "sub-agent-search";
tool1.pastTenseMessage = "Read package.json";

const tool2 = new vscode.ChatToolInvocationPart("search", "call-202");
tool2.subAgentInvocationId = "sub-agent-search"; // Same ID groups them
tool2.pastTenseMessage = "Searched for dependencies";

response.push(tool1);
response.push(tool2);
```

**Rendered as:**

```
▼ Search Agent
  ├─ ✓ Read package.json
  └─ ✓ Searched for dependencies
```

---

### 11. `presentation?: 'hidden' | 'hiddenAfterComplete' | undefined`

**Purpose:** Controls **visibility** of the tool invocation in the UI.

**UI Effect:**

| Value                   | Behavior                                           |
| ----------------------- | -------------------------------------------------- |
| `undefined` (default)   | Always visible                                     |
| `'hidden'`              | **Never rendered** - completely invisible to user  |
| `'hiddenAfterComplete'` | Visible while running, **hidden after completion** |

**Use Cases:**

- `'hidden'`: Internal/bookkeeping tools users shouldn't see
- `'hiddenAfterComplete'`: Temporary progress that clutters the UI after completion

**Example:**

```typescript
// Tool that should only show progress, then disappear
const part = new vscode.ChatToolInvocationPart("internal_cache", "call-301");
part.presentation = "hiddenAfterComplete";
part.invocationMessage = "Caching context...";
response.push(part);

// After completion, this will automatically hide
part.isComplete = true;
response.push(part);
```

---

## Complete Usage Example

Here's how these attributes work together in a real scenario:

```typescript
// 1. Start streaming the tool call
response.beginToolInvocation("call-500", "file_edit", {
  partialInput: { path: "src/app.ts" },
});

// 2. Tool is now executing
const part = new vscode.ChatToolInvocationPart("file_edit", "call-500");
part.invocationMessage = "Editing `src/app.ts`...";
part.isConfirmed = true; // Auto-confirmed
this.toolInvocations.set("call-500", part);

// 3. On completion
part.isComplete = true;
part.pastTenseMessage = "Modified `src/app.ts` (+15 -3 lines)";
response.push(part);

// 4. On failure
part.isComplete = true;
part.isError = true;
part.pastTenseMessage = "Failed to edit: Permission denied";
response.push(part);
```

---

## Visual Summary

```
┌──────────────────────────────────────────────────────────────┐
│  Tool Invocation Part                                        │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  [Icon based on toolName]                                    │
│                                                              │
│  ┌─ While running (isComplete=false) ─────────────────────┐  │
│  │  ⏳ {invocationMessage}                                │  │
│  │     └─ "Editing src/app.ts..."                         │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌─ When complete (isComplete=true) ──────────────────────┐  │
│  │  ✓ {pastTenseMessage}          (or ✗ if isError)      │  │
│  │     └─ "Edited src/app.ts (+15 -3 lines)"              │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌─ If confirmation needed (isConfirmed=false) ───────────┐  │
│  │  ⚠ {invocationMessage}                                 │  │
│  │    {originMessage}                                     │  │
│  │                              [Accept] [Deny]           │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌─ If toolSpecificData (terminal) ───────────────────────┐  │
│  │  ┌───────────────────────────────────┐                 │  │
│  │  │ $ npm install                     │                 │  │
│  │  │                      [Run] [Edit] │                 │  │
│  │  └───────────────────────────────────┘                 │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌─ If subAgentInvocationId ──────────────────────────────┐  │
│  │  ▼ Sub-Agent Name                                      │  │
│  │    ├─ ✓ Tool 1 result                                  │  │
│  │    └─ ✓ Tool 2 result                                  │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## API Lifecycle: Streaming Tool Invocations

The recommended pattern for using `ChatToolInvocationPart` with the streaming API:

### Step 1: Begin Tool Invocation (Streaming State)

```typescript
// Called when the language model starts streaming tool arguments
response.beginToolInvocation(toolCallId, toolName, {
  partialInput: {
    /* partial arguments */
  },
});
```

**UI Shows:** Spinner with tool name, possibly streaming partial arguments

### Step 2: Update Tool Invocation (Optional)

```typescript
// Called as more arguments stream in
response.updateToolInvocation(toolCallId, {
  partialInput: {
    /* more complete arguments */
  },
});
```

**UI Shows:** Updated streaming UI with more complete arguments

### Step 3: Push Completed Tool Invocation Part

```typescript
// Called when tool execution completes
const part = new vscode.ChatToolInvocationPart(toolName, toolCallId);
part.isComplete = true;
part.pastTenseMessage = "Completed successfully";
response.push(part);
```

**UI Shows:** Checkmark with past tense message

---

## Best Practices

### 1. Use Appropriate Messages

- `invocationMessage`: Present tense, action in progress
  - ✅ "Reading file..."
  - ❌ "Read file"
- `pastTenseMessage`: Past tense, completed action
  - ✅ "Read 150 lines from file"
  - ❌ "Reading file"

### 2. Provide Meaningful Tool Names

```typescript
// ❌ Bad: Generic name
new vscode.ChatToolInvocationPart("tool1", "call-123");

// ✅ Good: Descriptive name
new vscode.ChatToolInvocationPart("file_read", "call-123");
```

### 3. Handle Errors Gracefully

```typescript
const part = new vscode.ChatToolInvocationPart("bash", "call-456", true);
part.isComplete = true;
part.isError = true;
part.pastTenseMessage =
  "Command failed: Permission denied. Try running with sudo.";
response.push(part);
```

### 4. Use `presentation` to Reduce Clutter

```typescript
// Hide internal/housekeeping tools
const part = new vscode.ChatToolInvocationPart("internal_cache", "call-789");
part.presentation = "hidden";

// Or hide after completion to keep chat clean
const progressPart = new vscode.ChatToolInvocationPart("download", "call-101");
progressPart.presentation = "hiddenAfterComplete";
```

### 5. Group Related Tools with Sub-Agents

```typescript
const subAgentId = "code-analyzer-" + Date.now();

// All these tools will be grouped together
const readPart = new vscode.ChatToolInvocationPart("read", "call-1");
readPart.subAgentInvocationId = subAgentId;

const parsePart = new vscode.ChatToolInvocationPart("parse", "call-2");
parsePart.subAgentInvocationId = subAgentId;

const analyzePart = new vscode.ChatToolInvocationPart("analyze", "call-3");
analyzePart.subAgentInvocationId = subAgentId;
```

---

## Common Patterns

### Pattern 1: Simple Tool Execution

```typescript
case "tool_call": {
  response.beginToolInvocation(update.toolCallId, update.toolName);
  break;
}

case "tool_call_update": {
  if (update.status === "completed") {
    const part = new vscode.ChatToolInvocationPart(update.toolName, update.toolCallId);
    part.isComplete = true;
    part.pastTenseMessage = update.result;
    response.push(part);
  }
  break;
}
```

### Pattern 2: Tool with User Confirmation

```typescript
const part = new vscode.ChatToolInvocationPart("file_delete", toolCallId);
part.invocationMessage = "Delete 5 test files?";
part.originMessage = "Cleanup unused test fixtures";
part.isConfirmed = false; // Triggers confirmation UI
response.push(part);

// After user confirms...
part.isConfirmed = true;
part.isComplete = true;
part.pastTenseMessage = "Deleted 5 test files";
response.push(part);
```

### Pattern 3: Terminal Tool with Editable Command

```typescript
const part = new vscode.ChatToolInvocationPart("bash", toolCallId);
part.toolSpecificData = {
  commandLine: {
    original: "npm install",
    userEdited: "npm install --save-dev", // User can modify
  },
  language: "bash",
};
part.isComplete = true;
part.pastTenseMessage = "Ran npm install";
response.push(part);
```

---

## Troubleshooting

### Problem: Tool invocations not rendering

**Solution:** Make sure you're using the new streaming API:

```typescript
// ❌ Old API (removed)
response.prepareToolInvocation(toolName);

// ✅ New API
response.beginToolInvocation(toolCallId, toolName);
```

### Problem: Tool shows spinner forever

**Solution:** Always set `isComplete = true` when done:

```typescript
part.isComplete = true;
response.push(part);
```

### Problem: Completed message not showing

**Solution:** Use `pastTenseMessage` instead of `invocationMessage` for completed state:

```typescript
// ❌ Wrong
part.invocationMessage = "File read successfully";
part.isComplete = true;

// ✅ Correct
part.pastTenseMessage = "Read file successfully";
part.isComplete = true;
```

---

## References

- [VS Code Chat API Documentation](https://code.visualstudio.com/api/extension-guides/chat)
- [Proposed API: chatParticipantAdditions](https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.proposed.chatParticipantAdditions.d.ts)
- [VS Code Chat Rendering Source](https://github.com/microsoft/vscode/tree/main/src/vs/workbench/contrib/chat/browser/widget/chatContentParts/toolInvocationParts)
