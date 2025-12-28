import * as vscode from "vscode";
import { Uri } from "vscode";
import { AcpChatParticipant } from "./acpChatParticipant";
import { AcpSessionManager, Session } from "./acpSessionManager";
import { DisposableBase } from "./disposables";
import { VscodeSessionOptions } from "./types";

const EMPTY_CHAT_OPTIONS: Record<string, vscode.ChatSessionProviderOptionItem> =
  {
    [VscodeSessionOptions.Mode]: {
      id: "",
      name: "",
    },
    [VscodeSessionOptions.Model]: {
      id: "",
      name: "",
    },
  };

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
  }

  // start event definitions --------------------------------------------------
  private readonly _onDidChangeChatSessionOptions: vscode.EventEmitter<vscode.ChatSessionOptionChangeEvent> =
    new vscode.EventEmitter<vscode.ChatSessionOptionChangeEvent>();
  onDidChangeChatSessionOptions?: vscode.Event<vscode.ChatSessionOptionChangeEvent> =
    this._onDidChangeChatSessionOptions.event;
  // end event definitions -----------------------------------------------------

  async provideChatSessionContent(
    resource: vscode.Uri,
    _token: vscode.CancellationToken,
  ): Promise<vscode.ChatSession> {
    this.sessionManager.create(resource).then((session) => {
      this.participant.init(session);

      this.logChannel.debug(
        `firing option change for resource ${resource.toString()}`,
      );
      this._onDidChangeChatSessionOptions.fire({
        resource,
        updates: [
          {
            optionId: VscodeSessionOptions.Mode,
            value: session.defaultChatOptions.modeId,
          },
          {
            optionId: VscodeSessionOptions.Model,
            value: session.defaultChatOptions.modelId,
          },
        ],
      });
    });

    const session: vscode.ChatSession = {
      history: [],
      requestHandler: undefined,
      options: EMPTY_CHAT_OPTIONS,
    };
    return session;
  }

  // Currently in 1.108.0-insider this api is only called once when the provider is registered.
  // so we create a session and use the information from that. The same session will be used later for first providing content api call.
  async provideChatSessionProviderOptions(): Promise<vscode.ChatSessionProviderOptions> {
    return this.sessionManager
      .getDefault()
      .then((session) => this.buildOptionsGroup(session));
  }

  private buildOptionsGroup(
    session: Session,
  ): vscode.ChatSessionProviderOptions {
    const responseOptions: vscode.ChatSessionProviderOptions = {
      optionGroups: [],
    };

    const modeState = session?.client.getSupportedModeState();
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

    const modelState = session?.client.getSupportedModelState();
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
    const session = await this.sessionManager.get(resource);
    if (!session) {
      this.logChannel.warn(
        `No session found to handle provideHandleOptionsChange for ${resource.toString()}`,
      );
      return;
    }

    updates.forEach((update) => {
      if (update.optionId === VscodeSessionOptions.Mode && update.value) {
        session.client.changeMode(session.acpSessionId, update.value);
      }

      if (update.optionId === VscodeSessionOptions.Model && update.value) {
        session.client.changeModel(session.acpSessionId, update.value);
      }
    });
  }

  override dispose(): void {
    this._onDidChangeChatSessionOptions.dispose();
    super.dispose();
  }
}
