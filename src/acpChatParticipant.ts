// SPDX-License-Identifier: Apache-2.0
import {
  ContentBlock,
  SessionNotification,
  ToolCall,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import * as vscode from "vscode";
import { AcpSessionManager, Session } from "./acpSessionManager";
import { DisposableBase } from "./disposables";
import { PermissionPromptManager } from "./permissionPrompts";
import { buildDiffMarkdown, getToolInfo, ToolInfo } from "./chatRenderingUtils";

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
      part: vscode.ChatToolInvocationPart;
      title: string;
    }
  >();

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

    const cancellation = new vscode.CancellationTokenSource();
    session.pendingRequest = { cancellation };

    let timeout = setTimeout(() => {
      response.progress("Working...");
    }, 100);

    const subscription = session.client.onSessionUpdate((notification) => {
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
      this.renderSessionUpdate(notification, response);

      timeout = setTimeout(() => {
        response.progress("Working...");
      }, 5000);
    });

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
      const message =
        error instanceof Error ? error.message : String(error ?? "Unknown");
      // Render a Copilot-style error message in chat
      response.markdown(`> **Error:** ACP request failed. ${message}`);
    } finally {
      session.pendingRequest?.permissionContext?.dispose();
      session.pendingRequest = undefined;
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

  private renderSessionUpdate(
    notification: SessionNotification,
    response: vscode.ChatResponseStream,
  ): void {
    this.logger.trace(JSON.stringify(notification));
    const update = notification.update;

    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = this.getContentText(update.content);
        if (text) {
          response.markdown(text);
        } else {
          response.warning(
            "Received a non-text message from the agent that cannot be rendered.",
          );
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
        response.prepareToolInvocation(info.name);

        const invocation = new vscode.ChatToolInvocationPart(
          info.name,
          update.toolCallId,
          false,
        );
        invocation.invocationMessage = info.input ?? "";

        this.toolInvocations.set(update.toolCallId, {
          part: invocation,
          title: info.name,
        });

        response.push(invocation);
        break;
      }
      case "tool_call_update": {
        const tracked = this.toolInvocations.get(update.toolCallId);
        if (!tracked) {
          break;
        }

        const info = getToolInfo(update);
        const part = tracked.part;

        if (update.status === "completed" || update.status === "failed") {
          part.isConfirmed = update.status === "completed";
          part.isError = update.status === "failed" || undefined;
          part.isComplete = true;
          part.invocationMessage = info.output ?? "";
          response.push(part);

          this.handleToolContents(update, response);

          this.logger.info(
            `[tool_call] ${tracked.title} \n Input: ${info.input ?? "N/A"} \n Output: ${info.output ?? "N/A"}\n Status: ${update.status} \n\n`,
          );

          this.toolInvocations.delete(update.toolCallId);
        }
        break;
      }
      case "plan": {
        if (update.entries.length > 0) {
          response.markdown("## Plan\n");
          update.entries.forEach((entry, index) => {
            const entryText = entry.content;
            response.markdown(
              `-  [${entry.status === "completed" ? "x" : " "}] ${entryText}\n`,
            );
          });
        }
        break;
      }
      case "available_commands_update": {
        break;
      }
      case "current_mode_update": {
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

  private handleToolContents(
    update: ToolCallUpdate,
    stream: vscode.ChatResponseStream,
  ): void {
    if (!update.content?.length) {
      return;
    }

    for (const content of update.content) {
      if (content.type !== "diff") {
        continue;
      }

      const diffMarkdown = buildDiffMarkdown(
        content.path,
        content.oldText ?? undefined,
        content.newText ?? undefined,
      );
      if (!diffMarkdown) {
        continue;
      }
      stream.markdown(diffMarkdown);
    }
  }

  private toInlineDiff(oldText: string, newText: string): string {
    const normalize = (text: string): string => text.replace(/\r\n?/g, "\n");
    const original = normalize(oldText);
    const updated = normalize(newText);

    if (original === updated) {
      return "";
    }

    const oldLines = original.split("\n");
    const newLines = updated.split("\n");
    const m = oldLines.length;
    const n = newLines.length;

    const lcs = Array.from({ length: m + 1 }, () =>
      new Array<number>(n + 1).fill(0),
    );

    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        if (oldLines[i] === newLines[j]) {
          lcs[i][j] = lcs[i + 1][j + 1] + 1;
        } else {
          lcs[i][j] = Math.max(lcs[i + 1][j], lcs[i][j + 1]);
        }
      }
    }

    type DiffOp = { type: "common" | "add" | "remove"; line: string };
    const script: DiffOp[] = [];
    let i = 0;
    let j = 0;

    while (i < m && j < n) {
      if (oldLines[i] === newLines[j]) {
        script.push({ type: "common", line: oldLines[i] });
        i++;
        j++;
      } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
        script.push({ type: "remove", line: oldLines[i] });
        i++;
      } else {
        script.push({ type: "add", line: newLines[j] });
        j++;
      }
    }

    while (i < m) {
      script.push({ type: "remove", line: oldLines[i] });
      i++;
    }
    while (j < n) {
      script.push({ type: "add", line: newLines[j] });
      j++;
    }

    const hasChanges = script.some((part) => part.type !== "common");
    if (!hasChanges) {
      return "";
    }

    const diffLines: string[] = ["--- original", "+++ modified"];
    const oldStart = m > 0 ? 1 : 0;
    const newStart = n > 0 ? 1 : 0;
    diffLines.push(`@@ -${oldStart},${m} +${newStart},${n} @@`);

    for (const part of script) {
      const prefix =
        part.type === "add" ? "+" : part.type === "remove" ? "-" : " ";
      diffLines.push(`${prefix}${part.line}`);
    }

    return diffLines.join("\n");
  }
}
