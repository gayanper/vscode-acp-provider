// SPDX-License-Identifier: Apache-2.0
import { ContentBlock, SessionNotification } from "@agentclientprotocol/sdk";
import * as vscode from "vscode";
import { AcpSessionManager, Session } from "./acpSessionManager";
import { DisposableBase } from "./disposables";
import { PermissionPromptManager } from "./permissionPrompts";

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
        "[acp] No chat session found for resource:",
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
    response.progress("Connecting to ACP agent...");

    this.cancelPendingRequest(session);

    const cancellation = new vscode.CancellationTokenSource();
    session.pendingRequest = { cancellation };

    const subscription = session.client.onSessionUpdate((notification) => {
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
        `[debug] ACP agent finished with stop reason: ${result.stopReason}`,
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

    for (const turn of context.history ?? []) {
      if (this.isChatRequestTurn(turn)) {
        this.appendUserTurnBlocks(
          blocks,
          turn.prompt,
          turn.references,
          turn.toolReferences,
          turn.command,
        );
      } else {
        this.appendResponseTurnBlocks(blocks, turn);
      }
    }

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

  private appendResponseTurnBlocks(
    blocks: ContentBlock[],
    turn: vscode.ChatResponseTurn,
  ): void {
    const lines: string[] = [];
    for (const part of turn.response ?? []) {
      const formatted = this.formatResponsePart(part);
      if (formatted) {
        lines.push(formatted);
      }
    }

    const errorMessage = turn.result.errorDetails?.message?.trim();
    if (errorMessage) {
      lines.push(`[error] ${errorMessage}`);
    }

    const metadata = turn.result.metadata;
    if (metadata && Object.keys(metadata).length > 0) {
      try {
        lines.push(`[metadata] ${JSON.stringify(metadata)}`);
      } catch {
        /* noop */
      }
    }

    if (!lines.length) {
      return;
    }

    const prefix = turn.command
      ? `${turn.participant}: ${turn.command}`
      : (turn.participant ?? "assistant");
    blocks.push(
      this.createTextBlock(`${prefix}:
${lines.join("\n")}`),
    );
  }

  private formatResponsePart(
    part:
      | vscode.ChatResponseMarkdownPart
      | vscode.ChatResponseFileTreePart
      | vscode.ChatResponseAnchorPart
      | vscode.ChatResponseProgressPart
      | vscode.ChatResponseReferencePart
      | vscode.ChatResponseCommandButtonPart,
  ): string | undefined {
    if (part instanceof vscode.ChatResponseMarkdownPart) {
      return this.toPlainMarkdown(part.value);
    }
    if (part instanceof vscode.ChatResponseFileTreePart) {
      return this.formatFileTree(part.value, part.baseUri);
    }
    if (part instanceof vscode.ChatResponseAnchorPart) {
      return `[anchor] ${this.formatUriOrLocation(part.value, part.title)}`;
    }
    if (part instanceof vscode.ChatResponseProgressPart) {
      return `[progress] ${part.value}`;
    }
    if (part instanceof vscode.ChatResponseReferencePart) {
      return `[reference] ${this.formatUriOrLocation(part.value)}`;
    }
    if (part instanceof vscode.ChatResponseCommandButtonPart) {
      const title =
        typeof part.value.title === "string"
          ? part.value.title
          : part.value.command;
      return `[command] ${title}`;
    }
    return undefined;
  }

  private toPlainMarkdown(markdown: vscode.MarkdownString): string {
    return markdown.value ?? "";
  }

  private formatFileTree(
    tree: readonly vscode.ChatResponseFileTree[],
    baseUri: vscode.Uri,
  ): string {
    const lines: string[] = [];
    this.buildFileTreeLines(tree, 0, lines);
    const header = `[file tree ${this.formatUri(baseUri)}]`;
    return lines.length
      ? `${header}
${lines.join("\n")}`
      : `${header} (empty)`;
  }

  private buildFileTreeLines(
    entries: readonly vscode.ChatResponseFileTree[] | undefined,
    depth: number,
    lines: string[],
  ): void {
    if (!entries?.length) {
      return;
    }
    for (const entry of entries) {
      const indent = "  ".repeat(depth);
      lines.push(`${indent}- ${entry.name}`);
      if (entry.children?.length) {
        this.buildFileTreeLines(entry.children, depth + 1, lines);
      }
    }
  }

  private formatUriOrLocation(
    value: vscode.Uri | vscode.Location,
    title?: string,
  ): string {
    const target =
      value instanceof vscode.Location
        ? this.formatLocation(value)
        : this.formatUri(value);
    return title ? `${title} -> ${target}` : target;
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
    const update = notification.update;
    this.logger.trace(`Handling chat request for agent ${this.agentId} - update : ${JSON.stringify(update)}`);

    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = this.getContentText(update.content);
        if (text) {
          // Render agent text output as normal
          response.markdown(text);
        } else {
          // Non-text chunk: render a brief notice in chat and log details to output channel
          response.markdown(
            "> ℹ️ **Info:** Received a non-text message from the agent that cannot be rendered.",
          );
          this.logger.info(
            `[debug] Received non-text message chunk (non-renderable) from agent.`,
          );
        }
        break;
      }
      case "agent_thought_chunk": {
        const thought =
          this.getContentText(update.content) ?? "Agent is thinking...";
        response.markdown(`> ${thought}`);
        break;
      }
      case "tool_call": {
        const title = update.title ?? "Tool call";
        response.progress(`${title} (${update.status ?? "pending"})`);
        break;
      }
      case "tool_call_update": {
        const status = update.status ?? "in_progress";
        response.progress(`Tool update: ${status}`);
        break;
      }
      case "plan": {
        response.progress(`Plan received (${update.entries.length} steps)`);
        break;
      }
      case "available_commands_update": {
        response.progress("Agent shared available commands.");
        break;
      }
      case "current_mode_update": {
        response.progress(`Agent mode: ${update.currentModeId}`);
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
}
