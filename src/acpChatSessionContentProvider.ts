// SPDX-License-Identifier: Apache-2.0
import * as vscode from "vscode";
import { Uri } from "vscode";
import { AcpChatParticipant } from "./acpChatParticipant";
import { AcpSessionManager, Options, Session } from "./acpSessionManager";
import { DisposableBase } from "./disposables";
import { VscodeSessionOptions } from "./types";

export class AcpChatSessionContentProvider
  extends DisposableBase
  implements vscode.ChatSessionContentProvider {
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
      sessionManager.onDidChangeSessionOptions((event) => {
        this._onDidChangeChatSessionOptions.fire(event);
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
    let response;
    try {
      response = await this.sessionManager.createOrGet(resource);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logChannel.error(`Failed to create or load session: ${message}`);
      vscode.window.showErrorMessage(`ACP session failed: ${message}`);
      // Return an empty session with error in history so the UI isn't broken
      const errorSession: vscode.ChatSession = {
        history: [],
        requestHandler: this.participant.requestHandler,
        options: {},
      };
      return errorSession;
    }
    const { session: acpSession, history } = response;

    this.logChannel.debug(
      `Providing chat session content for resource: ${resource.toString()}, acpSessionId: ${acpSession.acpSessionId}, history length: ${history?.length || 0}`,
    );

    const session: vscode.ChatSession = {
      history: history || [],
      requestHandler: this.participant.requestHandler,
      options: {
        [VscodeSessionOptions.Mode]: acpSession.options.modeId,
        [VscodeSessionOptions.Model]: acpSession.options.modelId,
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

    return responseOptions;
  }

  async provideHandleOptionsChange(
    resource: Uri,
    updates: ReadonlyArray<vscode.ChatSessionOptionUpdate>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const session = await this.sessionManager.getActive(resource);
    if (!session) {
      this.logChannel.warn(
        `No session found to handle provideHandleOptionsChange for ${resource.toString()}`,
      );
      return;
    }

    for (const update of updates) {
      if (!update.value) {
        continue;
      }

      try {
        if (update.optionId === VscodeSessionOptions.Mode) {
          await session.client.changeMode(session.acpSessionId, update.value);
        }

        if (update.optionId === VscodeSessionOptions.Model) {
          await session.client.changeModel(session.acpSessionId, update.value);
        }

        this.sessionManager.updateSessionOptions(session, [update], false);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error ?? "Unknown");
        this.logChannel.error(
          `Failed to update session option ${update.optionId}: ${message}`,
        );
        vscode.window.showErrorMessage(
          `Failed to update ${update.optionId}: ${message}`,
        );
      }
    }
  }

  override dispose(): void {
    this._onDidChangeChatSessionOptions.dispose();
    this._onDidChangeChatSessionProviderOptions.dispose();
    super.dispose();
  }
}
