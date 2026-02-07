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

  private async renderChatPrompt(pending: PendingPrompt): Promise<void> {
    this.logger.trace(JSON.stringify(pending));

    const context = pending.context;
    if (!context) {
      return;
    }

    try {
      const toolCall = pending.request.toolCall as {
        title?: string;
        kind?: string;
        rawInput?: unknown;
      };
      const toolName = this.getToolName(toolCall);
      const command = this.formatCommand(toolCall.rawInput);
      const questionId = `${pending.promptId}-permission`;
      const question = new vscode.ChatQuestion(
        questionId,
        vscode.ChatQuestionType.SingleSelect,
        `Permission required: ${toolName}`,
        {
          message: new vscode.MarkdownString(
            `Execute: ${this.wrapInlineCode(command)}`,
          ),
          options: pending.request.options.map((option) => ({
            id: option.optionId,
            label: this.optionLabel(option),
            value: option.optionId,
          })),
          allowFreeformInput: false,
        },
      );

      const answers = await context.response.questionCarousel(
        [question],
        false,
      );
      if (!answers || this.pendingPrompt?.promptId !== pending.promptId) {
        this.resolvePrompt(pending.promptId, {
          outcome: { outcome: "cancelled" },
        });
        this.emitResultMessage(pending, "Permission denied.");
        return;
      }

      const answer = answers[questionId];
      let selection: string | undefined = undefined;
      if (typeof answer === "string") {
        selection = answer;
      } else if (
        typeof answer === "object" &&
        answer &&
        "selectedValue" in answer &&
        typeof answer.selectedValue === "string"
      ) {
        selection = answer.selectedValue;
      }

      if (!selection) {
        this.resolvePrompt(pending.promptId, {
          outcome: { outcome: "cancelled" },
        });
        this.emitResultMessage(pending, "Permission denied.");
        return;
      }

      const option = pending.optionsById.get(selection);
      if (!option) {
        this.resolvePrompt(pending.promptId, {
          outcome: { outcome: "cancelled" },
        });
        this.emitResultMessage(pending, "Permission denied.");
        return;
      }

      this.resolvePrompt(pending.promptId, {
        outcome: { outcome: "selected", optionId: option.optionId },
      });
      this.emitResultMessage(
        pending,
        `Permission granted: ${this.optionLabel(option)}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to render permission prompt: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.resolvePrompt(pending.promptId, {
        outcome: { outcome: "cancelled" },
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

  private getToolName(toolCall: { title?: string; kind?: string }): string {
    return toolCall.title ?? toolCall.kind ?? "Tool";
  }

  private formatCommand(rawInput: unknown): string {
    let command = "unknown";
    if (typeof rawInput === "string") {
      command = rawInput;
    } else if (rawInput && typeof rawInput === "object") {
      const maybeCommand = (rawInput as { command?: unknown }).command;
      if (typeof maybeCommand === "string") {
        command = maybeCommand;
      } else if (Array.isArray(maybeCommand)) {
        command = maybeCommand.join(" ");
      } else {
        const serialized = JSON.stringify(rawInput);
        if (serialized) {
          command = serialized;
        }
      }
    } else if (rawInput !== undefined) {
      command = String(rawInput);
    }

    const singleLine = command.replace(/\s+/g, " ").trim();
    return this.truncate(singleLine, 100);
  }

  private wrapInlineCode(value: string): string {
    if (value.length > 300) {
      value = value.substring(0, 300).concat("...");
    }
    return "`" + value + "`";
  }

  private truncate(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
      return value;
    }
    if (maxLength <= 3) {
      return value.slice(0, maxLength);
    }
    return `${value.slice(0, maxLength - 3)}...`;
  }

  private optionLabel(option: PermissionOption): string {
    return option.name ?? option.optionId;
  }

  private emitResultMessage(pending: PendingPrompt, message: string): void {
    pending.context?.response.markdown(message);
    pending.context?.response.markdown("\n\n");
  }

  private createPromptId(): string {
    return `acp-permission-${this.sessionContext?.sessionId}`;
  }
}
