// SPDX-License-Identifier: Apache-2.0
import {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import * as vscode from "vscode";
import { AcpPermissionHandler } from "./acpClient";
import { Session } from "./acpSessionManager";
import { DisposableBase } from "./disposables";

export interface PermissionResolutionPayload {
  readonly promptId: string;
  readonly sessionId: string;
  readonly optionId?: string;
}

export interface PermissionPromptContext {
  readonly session: Session;
  readonly response: vscode.ChatResponseStream;
  readonly token?: vscode.CancellationToken;
}

interface SessionChatContext {
  readonly sessionId: string;
  readonly response: vscode.ChatResponseStream;
  readonly agentLabel: string;
  readonly agentId: string;
  readonly token?: vscode.CancellationToken;
}

interface PendingPrompt {
  readonly promptId: string;
  readonly sessionId: string;
  readonly request: RequestPermissionRequest;
  readonly optionsById: Map<string, PermissionOption>;
  readonly context?: SessionChatContext;
  readonly resolve: (value: RequestPermissionResponse) => void;
  readonly reject: (reason?: unknown) => void;
  cancellationListener?: vscode.Disposable;
}

export function createPermissionResolveCommandId(agentId: string): string {
  return `acpClient.resolvePermission.${agentId}`;
}

export class PermissionPromptManager
  extends DisposableBase
  implements AcpPermissionHandler {
  private sessionContexts = new Map<string, SessionChatContext>();
  private pendingPrompts = new Map<string, PendingPrompt>();
  private promptCounter = 0;

  constructor(private readonly logger: vscode.LogOutputChannel) {
    super();
  }

  bindSessionResponse(context: PermissionPromptContext): vscode.Disposable {
    const sessionId = context.session.acpSessionId;
    if (!sessionId) {
      return new vscode.Disposable(() => {
        /* noop */
      });
    }

    const chatContext: SessionChatContext = {
      sessionId,
      response: context.response,
      agentLabel: context.session.agent.label,
      agentId: context.session.agent.id,
      token: context.token,
    };

    this.sessionContexts.set(sessionId, chatContext);
    return new vscode.Disposable(() => {
      const existing = this.sessionContexts.get(sessionId);
      if (existing === chatContext) {
        this.clearSession(sessionId);
      }
    });
  }

  clearSession(sessionId: string): void {
    this.sessionContexts.delete(sessionId);
    for (const [promptId, prompt] of this.pendingPrompts.entries()) {
      if (prompt.sessionId === sessionId) {
        this.resolvePrompt(promptId, {
          outcome: { outcome: "cancelled" },
        });
      }
    }
  }

  async requestPermission(
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const context = this.sessionContexts.get(request.sessionId);
    if (!context) {
      return this.promptViaModal(request);
    }

    const promptId = this.createPromptId(request.sessionId);
    return await new Promise<RequestPermissionResponse>((resolve, reject) => {
      const pending: PendingPrompt = {
        promptId,
        sessionId: request.sessionId,
        request,
        optionsById: new Map(
          request.options.map((option) => [option.optionId, option]),
        ),
        context,
        resolve,
        reject,
      };

      if (context.token) {
        pending.cancellationListener = context.token.onCancellationRequested(
          () => {
            this.resolvePrompt(promptId, {
              outcome: { outcome: "cancelled" },
            });
          },
        );
      }

      this.pendingPrompts.set(promptId, pending);
      this.renderChatPrompt(pending);
    });
  }

  resolveFromCommand(payload: PermissionResolutionPayload): void {
    if (!payload?.promptId || !payload.sessionId) {
      return;
    }

    const pending = this.pendingPrompts.get(payload.promptId);
    if (!pending || pending.sessionId !== payload.sessionId) {
      return;
    }

    if (payload.optionId) {
      const option = pending.optionsById.get(payload.optionId);
      if (!option) {
        this.resolvePrompt(pending.promptId, {
          outcome: { outcome: "cancelled" },
        });
        return;
      }

      this.resolvePrompt(pending.promptId, {
        outcome: { outcome: "selected", optionId: option.optionId },
      });
      this.emitResultMessage(pending, this.formatResultMessage(option));
    } else {
      this.resolvePrompt(pending.promptId, {
        outcome: { outcome: "cancelled" },
      });
      this.emitResultMessage(pending, "Permission denied.");
    }
  }

  private resolvePrompt(
    promptId: string,
    response: RequestPermissionResponse,
  ): void {
    const pending = this.pendingPrompts.get(promptId);
    if (!pending) {
      return;
    }

    this.pendingPrompts.delete(promptId);
    pending.cancellationListener?.dispose();
    pending.resolve(response);
  }

  private renderChatPrompt(pending: PendingPrompt): void {
    this.logger.trace(
      `Permission prompt ${pending.promptId} for session ${pending.sessionId}`,
    );

    const context = pending.context;
    if (!context) {
      return;
    }

    const toolCall = pending.request.toolCall;
    const message = new vscode.MarkdownString(
      toolCall.title ??
      `\`\`\`json\n ${JSON.stringify(toolCall.rawInput)}\n\`\`\``,
    );
    context.response.markdown("## Permission Required");
    context.response.markdown(message);
    const commandId = createPermissionResolveCommandId(context.agentId);
    for (const option of pending.request.options) {
      context.response.button({
        title: this.optionLabel(option),
        command: commandId,
        arguments: [
          {
            promptId: pending.promptId,
            sessionId: pending.sessionId,
            optionId: option.optionId,
          } satisfies PermissionResolutionPayload,
        ],
      });
    }

    const hasRejectOption = pending.request.options.some((option) =>
      option.kind.startsWith("reject"),
    );
    if (!hasRejectOption) {
      context.response.button({
        title: "Cancel",
        command: commandId,
        arguments: [
          {
            promptId: pending.promptId,
            sessionId: pending.sessionId,
          } satisfies PermissionResolutionPayload,
        ],
      });
    }
  }

  private async promptViaModal(
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const description = this.describeToolCall(request);
    const picks = request.options.map((option) => ({
      title: this.optionLabel(option),
      optionId: option.optionId,
    }));

    const selection = await vscode.window.showWarningMessage(
      `Permission required: ${description}`,
      { modal: true },
      ...picks,
    );

    if (!selection) {
      return { outcome: { outcome: "cancelled" } };
    }

    return {
      outcome: { outcome: "selected", optionId: selection.optionId },
    };
  }

  private describeToolCall(request: RequestPermissionRequest): string {
    const title = request.toolCall.title ?? "Tool call";
    const kind = request.toolCall.kind ?? "unknown";
    return `${title} (${kind})`;
  }

  private optionLabel(option: PermissionOption): string {
    return option.name ?? option.optionId;
  }

  private emitResultMessage(pending: PendingPrompt, message: string): void {
    pending.context?.response.markdown(message);
  }

  private formatResultMessage(option: PermissionOption): string {
    const label = this.optionLabel(option);
    if (option.kind?.startsWith("allow")) {
      return `Permission granted: ${label}`;
    }
    if (option.kind?.startsWith("reject")) {
      return `Permission denied: ${label}`;
    }
    return `Permission response: ${label}`;
  }

  private createPromptId(sessionId: string): string {
    this.promptCounter += 1;
    return `acp-permission-${sessionId}-${Date.now()}-${this.promptCounter}`;
  }
}
