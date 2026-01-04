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
  implements AcpPermissionHandler
{
  private sessionContext: SessionChatContext | null = null;
  private pendingPrompt: PendingPrompt | null = null;

  bindSessionResponse(context: PermissionPromptContext): vscode.Disposable {
    const sessionId = context.session.acpSessionId;
    if (!sessionId) {
      return new vscode.Disposable(() => {
        /* noop */
      });
    }

    this.clearSession(sessionId);

    const chatContext: SessionChatContext = {
      sessionId,
      response: context.response,
      agentLabel: context.session.agent.label,
      agentId: context.session.agent.id,
      token: context.token,
    };

    this.sessionContext = chatContext;
    return new vscode.Disposable(() => {
      if (this.sessionContext) {
        this.clearSession(this.sessionContext.sessionId);
      }
    });
  }

  clearSession(sessionId: string): void {
    this.sessionContext = null;
    if (this.pendingPrompt && this.pendingPrompt.sessionId === sessionId) {
      this.resolvePrompt(this.pendingPrompt.promptId, {
        outcome: { outcome: "cancelled" },
      });
    }
  }

  async requestPermission(
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const context = this.sessionContext;
    if (!context) {
      return this.promptViaModal(request);
    }

    const promptId = this.createPromptId();
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

      this.pendingPrompt = pending;
      this.renderChatPrompt(pending);
    });
  }

  resolveFromCommand(payload: PermissionResolutionPayload): void {
    if (!payload?.promptId || !payload.sessionId) {
      return;
    }

    const pending = this.pendingPrompt;
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
      this.emitResultMessage(
        pending,
        `Permission granted: ${this.optionLabel(option)}`,
      );
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
    const pending = this.pendingPrompt;
    if (!pending) {
      return;
    }

    this.pendingPrompt = null;
    pending.cancellationListener?.dispose();
    pending.resolve(response);
  }

  private renderChatPrompt(pending: PendingPrompt): void {
    const context = pending.context;
    if (!context) {
      return;
    }

    const toolInfo = this.describeToolCall(pending.request);
    const lines = [
      `### Permission required`,
      `**Agent:** ${context.agentLabel}`,
      `**Action:** ${toolInfo}`,
    ];
    const description = pending.request.toolCall.title;
    if (description) {
      lines.push(`**Details:** ${description}`);
    }

    context.response.markdown(lines.join("\n"));
    context.response.progress("Awaiting your decision...");

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

    context.response.button({
      title: "Deny",
      command: commandId,
      arguments: [
        {
          promptId: pending.promptId,
          sessionId: pending.sessionId,
        } satisfies PermissionResolutionPayload,
      ],
    });
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

  private createPromptId(): string {
    return `acp-permission-${this.sessionContext?.sessionId}`;
  }
}
