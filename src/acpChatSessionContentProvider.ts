// SPDX-License-Identifier: Apache-2.0
import * as vscode from "vscode";
import { Uri } from "vscode";
import {
  SessionConfigOption,
  SessionConfigSelectOption,
} from "@agentclientprotocol/sdk";
import { AcpChatParticipant } from "./acpChatParticipant";
import { AcpSessionManager, Options } from "./acpSessionManager";
import { DisposableBase } from "./disposables";
import { VscodeSessionOptions } from "./types";

export class AcpChatSessionContentProvider
  extends DisposableBase
  implements vscode.ChatSessionContentProvider
{
  constructor(
    private readonly sessionManager: AcpSessionManager,
    private readonly participant: AcpChatParticipant,
    private readonly logChannel: vscode.LogOutputChannel,
  ) {
    super();

    this._register(
      sessionManager.onDidOptionsChange(() => {
        this._onDidChangeChatSessionProviderOptions.fire();
      }),
    );

    this._register(
      sessionManager.onDidCurrentModeChange(({ resource, modeId }) => {
        this._onDidChangeChatSessionOptions.fire({
          resource,
          updates: [{ optionId: VscodeSessionOptions.Mode, value: modeId }],
        });
      }),
    );
  }

  // start event definitions --------------------------------------------------
  private readonly _onDidChangeChatSessionOptions: vscode.EventEmitter<vscode.ChatSessionOptionChangeEvent> =
    new vscode.EventEmitter<vscode.ChatSessionOptionChangeEvent>();
  onDidChangeChatSessionOptions?: vscode.Event<vscode.ChatSessionOptionChangeEvent> =
    this._onDidChangeChatSessionOptions.event;

  private readonly _onDidChangeChatSessionProviderOptions: vscode.EventEmitter<void> =
    new vscode.EventEmitter<void>();
  onDidChangeChatSessionProviderOptions?: vscode.Event<void> | undefined =
    this._onDidChangeChatSessionProviderOptions.event;
  // end event definitions -----------------------------------------------------

  async provideChatSessionContent(
    resource: vscode.Uri,
    _token: vscode.CancellationToken,
  ): Promise<vscode.ChatSession> {
    const response = await this.sessionManager.createOrGet(resource);
    const { session: acpSession, history } = response;

    this.logChannel.debug(
      `Providing chat session content for resource: ${resource.toString()}, acpSessionId: ${acpSession.acpSessionId}, history length: ${history?.length || 0}`,
    );

    const session: vscode.ChatSession = {
      history: history || [],
      requestHandler: this.participant.requestHandler,
      options: {
        [VscodeSessionOptions.Mode]: acpSession.defaultChatOptions.modeId,
        [VscodeSessionOptions.Model]: acpSession.defaultChatOptions.modelId,
        ...this.buildThoughtLevelOptions(
          acpSession.client
            .getConfigOptions()
            .filter((o) => o.category === "thought_level"),
        ),
      },
    };
    return session;
  }

  provideChatSessionProviderOptions(
    token: vscode.CancellationToken,
  ): Thenable<vscode.ChatSessionProviderOptions> {
    return this.sessionManager.getOptions().then((options) => {
      return this.buildOptionsGroup(options);
    });
  }

  private buildOptionsGroup(
    options: Options,
  ): vscode.ChatSessionProviderOptions {
    const responseOptions: vscode.ChatSessionProviderOptions = {
      optionGroups: [],
    };

    const modeState = options.modes;
    if (modeState) {
      const modeOptions: vscode.ChatSessionProviderOptionItem[] =
        modeState.availableModes.map((mode) => ({
          id: mode.id,
          name: mode.name,
          description: mode.description || undefined,
        }));
      responseOptions.optionGroups?.push({
        id: VscodeSessionOptions.Mode,
        name: vscode.l10n.t("Mode"),
        description: vscode.l10n.t("Select the mode for the chat session"),
        items: modeOptions,
      });
    }

    const modelState = options.models;
    if (modelState) {
      const modelOptions: vscode.ChatSessionProviderOptionItem[] =
        modelState.availableModels.map((model) => ({
          id: model.modelId,
          name: model.name,
          description: model.description || undefined,
        }));
      responseOptions.optionGroups?.push({
        id: VscodeSessionOptions.Model,
        name: vscode.l10n.t("Model"),
        description: vscode.l10n.t("Select the model for the chat session"),
        items: modelOptions,
      });
    }

    if (options.thoughtLevelOptions) {
      for (const configOption of options.thoughtLevelOptions) {
        // Only flat options (not grouped) are supported for thought_level
        const flatOptions = configOption.options.filter(
          (opt): opt is SessionConfigSelectOption => "value" in opt,
        );
        responseOptions.optionGroups?.push({
          id: configOption.id,
          name: vscode.l10n.t(configOption.name),
          description: configOption.description
            ? vscode.l10n.t(configOption.description)
            : undefined,
          items: flatOptions.map((opt) => ({
            id: opt.value,
            name: opt.name,
            description: opt.description ?? undefined,
          })),
        });
      }
    }

    return responseOptions;
  }

  private buildThoughtLevelOptions(
    thoughtLevelOptions: SessionConfigOption[],
  ): Record<string, string> {
    const result: Record<string, string> = {};
    for (const option of thoughtLevelOptions) {
      result[option.id] = option.currentValue;
    }
    return result;
  }

  async provideHandleOptionsChange(
    resource: Uri,
    updates: ReadonlyArray<vscode.ChatSessionOptionUpdate>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const session = this.sessionManager.getActive(resource);
    if (!session) {
      this.logChannel.warn(
        `No session found to handle provideHandleOptionsChange for ${resource.toString()}`,
      );
      return;
    }

    const knownThoughtLevelIds = new Set(
      session.client
        .getConfigOptions()
        .filter((o) => o.category === "thought_level")
        .map((o) => o.id),
    );

    updates.forEach((update) => {
      if (update.optionId === VscodeSessionOptions.Mode && update.value) {
        session.client.changeMode(session.acpSessionId, update.value);
      }

      if (update.optionId === VscodeSessionOptions.Model && update.value) {
        session.client.changeModel(session.acpSessionId, update.value);
      }

      if (
        knownThoughtLevelIds.has(update.optionId) &&
        update.value &&
        typeof update.value === "string"
      ) {
        session.client.setSessionConfigOption(
          session.acpSessionId,
          update.optionId,
          update.value,
        );
      }
    });
  }

  override dispose(): void {
    this._onDidChangeChatSessionOptions.dispose();
    this._onDidChangeChatSessionProviderOptions.dispose();
    super.dispose();
  }
}
