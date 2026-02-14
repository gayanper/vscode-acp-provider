// SPDX-License-Identifier: Apache-2.0
import {
  ContentBlock,
  SessionNotification,
  ToolCallUpdate,
  type ToolCall,
} from "@agentclientprotocol/sdk";
import * as vscode from "vscode";
import { AcpSessionManager, Session } from "./acpSessionManager";
import {
  buildDiffStats,
  buildMcpToolInvocationData,
  buildQuestionCarouselPart,
  buildTerminalToolInvocationData,
  getSubAgentInvocationId,
  getToolInfo,
  isTerminalToolInvocation,
  parseQuestions,
  resolveUri,
  type ToolInfo,
} from "./chatRenderingUtils";
import { createDiffUri, setDiffContent } from "./diffContentProvider";
import { DisposableBase } from "./disposables";
import { PermissionPromptManager } from "./permissionPrompts";
import {
  currentWorkspaceRoot,
  extractReadableErrorMessage,
  ResolvableCallback,
  VscodeToolNames,
} from "./types";

/**
 * Check if a title matches known question tool call patterns (case-insensitive).
 * Matches patterns with or without separators (-, _) in any case:
 * - "question", "Question", "QUESTION"
 * - "ask_user_question", "ask-user-question", "askUserQuestion", "AskUserQuestion"
 */
function isQuestionToolCall(title: string | undefined): boolean {
  if (!title) {
    return false;
  }
  // Normalize by converting to lowercase and removing hyphens and underscores
  const normalized = title.toLowerCase().replace(/[-_]/g, "");
  return normalized === "question" || normalized === "askuserquestion";
}

export class AcpChatParticipant extends DisposableBase {
  requestHandler: vscode.ChatRequestHandler = this.handleRequest.bind(this);
  onDidReceiveFeedback: vscode.Event<vscode.ChatResultFeedback> =
    new vscode.EventEmitter<vscode.ChatResultFeedback>().event;

  constructor(
    private readonly permissionManager: PermissionPromptManager,
    private readonly sessionManager: AcpSessionManager,
    private readonly logger: vscode.LogOutputChannel,
    readonly agentId: string,
  ) {
    super();
  }

  private readonly toolInvocations = new Map<
    string,
    {
      name: string;
      invocationMessage?: string;
      subAgentInvocationId?: string;
    }
  >();
  private readonly questionToolCalls = new Set<string>();
  private currentSession: Session | null = null;
  private currentToolInvocationToken:
    | vscode.ChatParticipantToolToken
    | undefined;

  private externalEditorCallbacks = new Map<string, ResolvableCallback[]>();

  private async handleRequest(
    request: vscode.ChatRequest,
    context: vscode.ChatContext,
    response: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const sessionResource =
      context.chatSessionContext?.chatSessionItem.resource;
    if (!sessionResource) {
      // Info-style message in chat UI
      response.markdown(
        "> ℹ️ **Info:** ACP requests must be made from within an ACP chat session.",
      );
      return;
    }

    // Defensive lookup: accept Uri or resource-like objects by using getByKey.
    const session = this.sessionManager.getActive(sessionResource);
    if (!session) {
      // Log minimal diagnostics to help debugging when resources don't match
      console.warn(
        "No chat session found for resource:",
        sessionResource,
        typeof sessionResource,
      );
      // Error-style message in chat UI (keep actionable error visible)
      response.markdown(
        "> **Error:** ACP session is not initialized yet. Open or create an ACP session to continue.",
      );
      return;
    }

    if (token.isCancellationRequested) {
      return;
    }
    session.markAsInProgress();
    this.cancelPendingRequest(session);
    this.currentSession = session;
    this.currentToolInvocationToken = request.toolInvocationToken;

    const cancellation = new vscode.CancellationTokenSource();
    session.pendingRequest = { cancellation };

    let timeout = setTimeout(() => {
      response.progress("Working...");
    }, 100);

    const subscription = session.client.onSessionUpdate(
      async (notification) => {
        clearTimeout(timeout);
        if (
          !session.acpSessionId ||
          notification.sessionId !== session.acpSessionId
        ) {
          return;
        }
        if (token.isCancellationRequested) {
          return;
        }
        await this.renderSessionUpdate(notification, response);

        timeout = setTimeout(() => {
          response.progress("Working...");
        }, 5000);
      },
    );

    const cancellationRegistration = token.onCancellationRequested(() => {
      cancellation.cancel();
      if (session.acpSessionId) {
        session.client.cancel(session.acpSessionId).catch(() => {
          /* noop */
        });
      }
      const pending = session.pendingRequest;
      if (pending?.cancellation === cancellation) {
        pending.permissionContext?.dispose();
      }
    });

    try {
      const sessionId = session.acpSessionId;
      this.refreshPermissionContext(session, response, token);

      const promptBlocks = this.buildPromptBlocks(request, context);
      if (promptBlocks.length === 0) {
        // Informational guidance in chat
        response.markdown(
          "> ℹ️ **Info:** Prompt cannot be empty. Please provide a question or instruction for the ACP agent.",
        );
        session.markAsCompleted();
        return;
      }
      if (token.isCancellationRequested) {
        return;
      }

      const result = await session.client.prompt(sessionId, promptBlocks);
      if (token.isCancellationRequested) {
        return;
      }

      session.markAsCompleted();
      if (context.chatSessionContext.isUntitled) {
        session.title =
          request.prompt.substring(0, Math.min(request.prompt.length, 50)) ||
          session.title;
      }
      this.sessionManager.syncSessionState(sessionResource, session);

      // Log detailed stop reason to the ACP Output channel for troubleshooting.
      this.logger.info(
        `ACP agent finished with stop reason: ${result.stopReason}`,
      );
    } catch (error) {
      if (token.isCancellationRequested) {
        return;
      }
      session.markAsFailed();
      // Render a Copilot-style error message in chat
      response.markdown(
        `> **Error:** ACP request failed. ${extractReadableErrorMessage(error)}`,
      );
    } finally {
      session.pendingRequest?.permissionContext?.dispose();
      session.pendingRequest = undefined;
      this.currentSession = null;
      this.currentToolInvocationToken = undefined;
      cancellationRegistration.dispose();
      subscription.dispose();
    }
  }

  private buildPromptBlocks(
    request: vscode.ChatRequest,
    context: vscode.ChatContext,
  ): ContentBlock[] {
    const blocks: ContentBlock[] = [];
    this.appendUserTurnBlocks(
      blocks,
      request.prompt,
      request.references,
      request.toolReferences,
      request.command,
    );

    return blocks;
  }

  private appendUserTurnBlocks(
    blocks: ContentBlock[],
    prompt: string | undefined,
    references: readonly vscode.ChatPromptReference[] | undefined,
    toolReferences:
      | readonly vscode.ChatLanguageModelToolReference[]
      | undefined,
    command?: string,
  ): void {
    const trimmedPrompt = prompt?.trim();
    if (trimmedPrompt) {
      const label = command ? `User (${command})` : "User";
      blocks.push(this.createTextBlock(`${label}: ${trimmedPrompt}`));
    }

    this.appendReferenceBlocks(blocks, references);
    this.appendToolReferenceBlocks(blocks, toolReferences);
  }

  private appendReferenceBlocks(
    blocks: ContentBlock[],
    references: readonly vscode.ChatPromptReference[] | undefined,
  ): void {
    if (!references?.length) {
      return;
    }

    for (const reference of references) {
      const description = reference.modelDescription?.trim();
      const valueText = this.formatReferenceValue(reference.value);
      const range = reference.range
        ? ` [${reference.range[0]}, ${reference.range[1]}]`
        : "";
      const parts = [`Reference (${reference.id})${range}`];
      if (description) {
        parts.push(description);
      }
      if (valueText) {
        parts.push(valueText);
      }
      blocks.push(this.createTextBlock(parts.join(": ")));
    }
  }

  private appendToolReferenceBlocks(
    blocks: ContentBlock[],
    toolReferences:
      | readonly vscode.ChatLanguageModelToolReference[]
      | undefined,
  ): void {
    if (!toolReferences?.length) {
      return;
    }

    for (const tool of toolReferences) {
      const range = tool.range ? ` [${tool.range[0]}, ${tool.range[1]}]` : "";
      blocks.push(
        this.createTextBlock(`Tool reference (${tool.name})${range}`),
      );
    }
  }

  private formatReferenceValue(value: unknown): string | undefined {
    if (typeof value === "string") {
      return value;
    }
    if (value instanceof vscode.Uri) {
      return this.formatUri(value);
    }
    if (value instanceof vscode.Location) {
      return this.formatLocation(value);
    }
    if (value === undefined || value === null) {
      return undefined;
    }
    if (typeof value === "object") {
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    }
    return String(value);
  }

  private formatLocation(location: vscode.Location): string {
    const line = location.range.start.line + 1;
    const column = location.range.start.character + 1;
    return `${this.formatUri(location.uri)}:${line}:${column}`;
  }

  private formatUri(uri: vscode.Uri): string {
    if (uri.scheme === "file") {
      const relative = vscode.workspace.asRelativePath(uri, false);
      if (relative && relative !== uri.fsPath) {
        return relative;
      }
      return uri.fsPath;
    }
    return uri.toString();
  }

  private createTextBlock(text: string): ContentBlock {
    return { type: "text", text };
  }

  private isChatRequestTurn(
    turn: vscode.ChatRequestTurn | vscode.ChatResponseTurn,
  ): turn is vscode.ChatRequestTurn {
    return "prompt" in turn;
  }

  private async renderSessionUpdate(
    notification: SessionNotification,
    response: vscode.ChatResponseStream,
  ): Promise<void> {
    this.logger.trace(JSON.stringify(notification));
    const update = notification.update;

    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = this.getContentText(update.content);
        if (text) {
          response.markdown(text);
        } else {
          this.logger.trace("The last update did not had a valid text content");
        }
        break;
      }
      case "agent_thought_chunk": {
        const thinkingText = this.getContentText(update.content);
        if (thinkingText) {
          response.thinkingProgress({
            id: "agent_thought",
            text: thinkingText,
          });
        }
        break;
      }
      case "tool_call": {
        const info = getToolInfo(update);
        const subAgentInvocationId = getSubAgentInvocationId(update);
        const invocationMessage = info.input ?? "";
        this.toolInvocations.set(update.toolCallId, {
          name: info.name,
          invocationMessage,
          subAgentInvocationId,
        });
        const partialInput = update.rawInput ?? info.input;
        const streamData:
          | (vscode.ChatToolInvocationStreamData & {
              subagentInvocationId?: string;
            })
          | undefined =
          partialInput !== undefined || subAgentInvocationId
            ? {
                ...(partialInput !== undefined ? { partialInput } : {}),
                ...(subAgentInvocationId
                  ? { subagentInvocationId: subAgentInvocationId }
                  : {}),
              }
            : undefined;
        response.beginToolInvocation(
          update.toolCallId,
          info.name || "Tool",
          streamData,
        );

        // Track question tool calls
        if (info.kind === "other" && isQuestionToolCall(update.title)) {
          this.questionToolCalls.add(update.toolCallId);
        }

        // Track if a file change
        this.handleFileEditToolCalls(info, update, response);
      }
      case "tool_call_update": {
        const tracked = this.toolInvocations.get(update.toolCallId);
        const info = getToolInfo(update);
        if (update.status !== "completed" && update.status !== "failed") {
          // Handle question tool calls using questionCarousel
          if (this.questionToolCalls.has(update.toolCallId)) {
            const questions = parseQuestions(update);
            if (questions) {
              try {
                const answers = await response.questionCarousel(
                  questions,
                  false,
                );

                // Send answers back to the agent
                if (this.currentSession?.acpSessionId && answers) {
                  await this.currentSession.client.sendQuestionAnswers(
                    this.currentSession.acpSessionId,
                    update.toolCallId,
                    answers,
                  );
                }
              } catch (error) {
                this.logger.error(
                  `Failed to handle question carousel: ${error instanceof Error ? error.message : String(error)}`,
                );
              }
            }
          }

          if (info.input) {
            if (tracked) {
              tracked.invocationMessage = info.input;
            }
            response.updateToolInvocation(update.toolCallId, {
              partialInput: update.rawInput ?? info.input,
            });
          }
          this.handleFileEditToolCalls(info, update, response);
          break;
        }

        this.questionToolCalls.delete(update.toolCallId);

        const toolName = info.name || tracked?.name || "Tool";
        const part = new vscode.ChatToolInvocationPart(
          toolName,
          update.toolCallId,
          update.status === "failed",
        );
        part.originMessage = toolName;
        const invocationMessage = info.input ?? tracked?.invocationMessage;
        if (invocationMessage) {
          part.invocationMessage = invocationMessage;
        }
        if (info.output) {
          part.pastTenseMessage = info.output;
        }
        part.isConfirmed = update.status === "completed";
        part.isError = update.status === "failed" ? true : false;
        part.isComplete = true;
        if (update.status === "completed") {
          part.presentation = "hiddenAfterComplete";
        }
        const subAgentInvocationId =
          tracked?.subAgentInvocationId ?? getSubAgentInvocationId(update);
        if (subAgentInvocationId) {
          part.subAgentInvocationId = subAgentInvocationId;
        }
        const terminalData = isTerminalToolInvocation(update, info)
          ? buildTerminalToolInvocationData(update, info)
          : undefined;
        part.toolSpecificData =
          terminalData ?? buildMcpToolInvocationData(info);
        response.push(part);

        // Track as external edit, if file change
        const handled = this.handleFileEditToolCalls(info, update, response);
        if (!handled) {
          // fallback to file diffs
          this.handleDiffToolContents(update, response);
        }

        this.toolInvocations.delete(update.toolCallId);
        break;
      }
      case "plan": {
        await this.renderPlanUpdate(update.entries, response);
        break;
      }
      case "available_commands_update": {
        break;
      }
      case "current_mode_update": {
        break;
      }
      case "session_info_update": {
        break;
      }
      default:
        break;
    }
  }

  private cancelPendingRequest(session: Session): void {
    const pending = session.pendingRequest;
    if (!pending) {
      return;
    }
    pending.cancellation.cancel();
    pending.permissionContext?.dispose();
    session.pendingRequest = undefined;
  }

  private refreshPermissionContext(
    sessionState: Session,
    response: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): void {
    const pending = sessionState.pendingRequest;
    if (!pending) {
      return;
    }
    pending.permissionContext?.dispose();
    if (!sessionState.acpSessionId) {
      pending.permissionContext = undefined;
      return;
    }
    pending.permissionContext = this.bindPermissionContext(
      sessionState,
      response,
      token,
    );
  }

  private bindPermissionContext(
    sessionState: Session,
    response: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): vscode.Disposable {
    return this.permissionManager.bindSessionResponse({
      session: sessionState,
      response,
      token,
      toolInvocationToken: this.currentToolInvocationToken,
    });
  }

  private getContentText(content?: ContentBlock): string | undefined {
    if (!content) {
      return undefined;
    }
    if (content.type === "text") {
      return content.text;
    }
    return undefined;
  }

  private async renderPlanUpdate(
    entries: Array<{
      content: string;
      status?: string;
      priority?: string;
    }>,
    response: vscode.ChatResponseStream,
  ): Promise<void> {
    if (!entries.length) {
      return;
    }

    const toolName = VscodeToolNames.TodoList;
    const toolAvailable = vscode.lm.tools.some(
      (tool) => tool.name === toolName,
    );
    if (toolAvailable && this.currentToolInvocationToken) {
      const todoList = entries.map((entry, index) => ({
        id: index + 1,
        title: entry.content,
        status: this.mapPlanStatus(entry.status),
      }));
      try {
        await vscode.lm.invokeTool(toolName, {
          toolInvocationToken: this.currentToolInvocationToken,
          input: { todoList },
        });
        return;
      } catch (error) {
        this.logger.warn(
          `Failed to render TodoList tool for plan update: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // fallback to markdown
    response.markdown("## Plan\n");
    for (const entry of entries) {
      const checkbox = entry.status === "completed" ? "x" : " ";
      response.markdown(`-  [${checkbox}] ${entry.content}\n`);
    }
  }

  private mapPlanStatus(
    status?: string,
  ): "not-started" | "in-progress" | "completed" {
    switch (status) {
      case "completed":
        return "completed";
      case "in_progress":
        return "in-progress";
      case "pending":
      default:
        return "not-started";
    }
  }

  private handleDiffToolContents(
    update: ToolCallUpdate,
    stream: vscode.ChatResponseStream,
  ): void {
    if (!update.content?.length) {
      return;
    }

    const workspaceRoot = currentWorkspaceRoot();
    const diffEntries: vscode.ChatResponseDiffEntry[] = [];
    let diffIndex = 0;
    for (const content of update.content) {
      if (content.type !== "diff") {
        continue;
      }

      const oldText = content.oldText ?? "";
      const newText = content.newText ?? "";
      const hasOriginal = content.oldText !== undefined;
      const hasModified = content.newText !== undefined;
      const isDeletion =
        hasOriginal &&
        (content.newText === "" || content.newText === undefined);
      const fileUri = resolveUri(content.path, workspaceRoot);
      const originalUri = hasOriginal
        ? createDiffUri({
            side: "original",
            toolCallId: update.toolCallId,
            fileUri,
            index: diffIndex,
          })
        : undefined;
      const modifiedUri = hasModified
        ? createDiffUri({
            side: "modified",
            toolCallId: update.toolCallId,
            fileUri,
            index: diffIndex,
          })
        : undefined;
      if (originalUri) {
        setDiffContent(originalUri, oldText);
      }
      if (modifiedUri) {
        setDiffContent(modifiedUri, newText);
      }
      diffEntries.push({
        originalUri,
        modifiedUri,
        goToFileUri: fileUri,
        ...buildDiffStats(
          content.oldText ?? undefined,
          content.newText ?? undefined,
        ),
      });
      if (hasOriginal && hasModified && !isDeletion) {
        stream.textEdit(
          fileUri,
          vscode.TextEdit.replace(this.getFullTextRange(oldText), newText),
        );
        stream.textEdit(fileUri, true);
      } else if (!hasOriginal && hasModified) {
        stream.workspaceEdit([{ newResource: fileUri }]);
        if (newText) {
          stream.textEdit(
            fileUri,
            vscode.TextEdit.insert(new vscode.Position(0, 0), newText),
          );
          stream.textEdit(fileUri, true);
        }
      } else if (isDeletion) {
        stream.workspaceEdit([{ oldResource: fileUri }]);
      }

      diffIndex++;
    }
  }

  private getFullTextRange(text: string): vscode.Range {
    if (!text) {
      return new vscode.Range(
        new vscode.Position(0, 0),
        new vscode.Position(0, 0),
      );
    }
    const lines = text.split("\n");
    const lastLine = lines[lines.length - 1] ?? "";
    return new vscode.Range(
      new vscode.Position(0, 0),
      new vscode.Position(lines.length - 1, lastLine.length),
    );
  }

  private handleFileEditToolCalls(
    info: ToolInfo,
    data: ToolCall | ToolCallUpdate,
    stream: vscode.ChatResponseStream,
  ): boolean {
    if (data.status === "pending" || data.status === "in_progress") {
      if (this.externalEditorCallbacks.has(info.toolCallId)) {
        return true; // consider it as already handled.
      }

      switch (info.kind) {
        case "edit": {
          if (info.resources) {
            const callbacks: ResolvableCallback[] = [];
            info.resources?.forEach((r) => {
              const callback = new ResolvableCallback();
              callbacks.push(callback);
              stream.externalEdit(r, callback.callback);
            });
            this.externalEditorCallbacks.set(info.toolCallId, callbacks);
            return true;
          }
          return false;
        }
        case "other": {
          if (
            data.title === "apply_patch" &&
            data.rawInput &&
            typeof data.rawInput === "object" &&
            "patchText" in data.rawInput
          ) {
            const patchText = data.rawInput.patchText as string;
            const match = patchText.match(/.*:(.+?)(?:\n).*/);
            if (match) {
              const filePath = match[1];
              const resource = resolveUri(filePath, currentWorkspaceRoot());
              const callback = new ResolvableCallback();
              stream.externalEdit(resource, () => callback.callback());
              this.externalEditorCallbacks.set(info.toolCallId, [callback]);
              return true;
            }
          }
        }
      }
      return false;
    } else {
      if (this.externalEditorCallbacks.has(info.toolCallId)) {
        // resolve call callbacks
        this.externalEditorCallbacks
          .get(info.toolCallId)
          ?.forEach((c) => c.resolve());
        this.externalEditorCallbacks.delete(info.toolCallId);

        return true;
      }
    }
    return false;
  }
}
