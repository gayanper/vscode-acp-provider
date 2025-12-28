import * as vscode from "vscode";
import { Uri } from "vscode";
import { AcpChatParticipant } from "./acpChatParticipant";
import { AcpClient, AcpPermissionHandler } from "./acpClient";
import { AgentRegistryEntry } from "./agentRegistry";
import { createSessionType, getAgentIdFromResource } from "./chatIdentifiers";
import { DisposableBase } from "./disposables";
import { PermissionPromptManager } from "./permissionPrompts";
import { getWorkspaceCwd } from "./permittedPaths";
import { createSessionState, SessionState } from "./sessionState";
import { VscodeSessionOptions } from "./types";

type AcpChatSessionContentProviderOptions = {
  readonly agent: AgentRegistryEntry;
  readonly logChannel: vscode.OutputChannel;
  readonly participant: AcpChatParticipant;
};

type ActiveSessionContext = {
  readonly session: vscode.ChatSession;
  readonly state: SessionState | null;
};

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
  implements vscode.ChatSessionContentProvider, vscode.ChatSessionItemProvider
{
  private current: SessionState | null = null;
  private permissionHander: AcpPermissionHandler;

  constructor(private readonly options: AcpChatSessionContentProviderOptions) {
    super();
    this.permissionHander = new PermissionPromptManager();
  }

  // start event definitions --------------------------------------------------

  private readonly _onDidChangeChatSessionItems: vscode.EventEmitter<void> =
    new vscode.EventEmitter<void>();

  onDidChangeChatSessionItems: vscode.Event<void> =
    this._onDidChangeChatSessionItems.event;

  private readonly _onDidCommitChatSessionItem: vscode.EventEmitter<{
    original: vscode.ChatSessionItem;
    modified: vscode.ChatSessionItem;
  }> = new vscode.EventEmitter<{
    original: vscode.ChatSessionItem;
    modified: vscode.ChatSessionItem;
  }>();

  onDidCommitChatSessionItem: vscode.Event<{
    original: vscode.ChatSessionItem;
    modified: vscode.ChatSessionItem;
  }> = this._onDidCommitChatSessionItem.event;

  private readonly _onDidChangeChatSessionOptions: vscode.EventEmitter<vscode.ChatSessionOptionChangeEvent> =
    new vscode.EventEmitter<vscode.ChatSessionOptionChangeEvent>();
  onDidChangeChatSessionOptions?: vscode.Event<vscode.ChatSessionOptionChangeEvent> =
    this._onDidChangeChatSessionOptions.event;

  // end event definitions -----------------------------------------------------

  provideChatSessionItems(
    token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.ChatSessionItem[]> {
    return new Promise(async (resolve) => {
      const items: vscode.ChatSessionItem[] = [];
      resolve(items);
    });
  }

  async provideChatSessionContent(
    resource: vscode.Uri,
    _token: vscode.CancellationToken,
  ): Promise<vscode.ChatSession> {
    const key = resource.toString();
    const agentId = getAgentIdFromResource(resource);
    if (!agentId) {
      throw new Error(
        `No ACP agent associated with resource ${resource.toString()}`,
      );
    }

    const agent = this.options.agent;
    this.createSessionState(agent, resource).then((state) => {
      this._onDidChangeChatSessionOptions.fire({
        resource,
        updates: [
          {
            optionId: VscodeSessionOptions.Mode,
            value: state.options.defaultMode,
          },
          {
            optionId: VscodeSessionOptions.Model,
            value: state.options.defaultModel,
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

  async createSessionState(
    agent: AgentRegistryEntry,
    vscodeResource: vscode.Uri,
  ): Promise<SessionState> {
    if (this.current) {
      return this.current;
    }

    const key = vscodeResource.toString();
    const client = new AcpClient(
      agent,
      this.permissionHander,
      this.options.logChannel,
    );
    const cwd = getWorkspaceCwd();
    const result = await client.createSession(cwd);
    const sessionId = result.sessionId;

    const state = createSessionState(
      agent,
      vscodeResource,
      client,
      sessionId,
      result.modes?.currentModeId || "",
      result.models?.currentModelId || "",
    );
    this.options.participant.init(state);
    this.current = state;
    return state;
  }

  // Currently in 1.108.0-insider this api is only called once when the provider is registered.
  // so we create a session and use the information from that. The same session will be used later for first providing content api call.
  async provideChatSessionProviderOptions(): Promise<vscode.ChatSessionProviderOptions> {
    const session = this.current;
    if (!session) {
      return new Promise(async (resolve) => {
        const sessionState = await this.createSessionState(
          this.options.agent,
          vscode.Uri.parse(`${createSessionType(this.options.agent.id)}://`),
        );
        resolve(this.buildOptionsGroup(sessionState));
      });
    } else {
      return this.buildOptionsGroup(session);
    }
  }

  private buildOptionsGroup(
    session: SessionState,
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
    if(!this.current) {
      this.options.logChannel.appendLine("[warn] Session state not initialized yet to handle provideHandleOptionsChange");
      return;
    }

    updates.forEach((update) => {
      if (update.optionId === VscodeSessionOptions.Mode && update.value) {
        this.current?.client.changeMode(this.current.acpSessionId, update.value);
      }

      if (update.optionId === VscodeSessionOptions.Model && update.value) {
        this.current?.client.changeModel(this.current.acpSessionId, update.value);
      }
    });
  }

  override dispose(): void {
    super.dispose();
    this._onDidChangeChatSessionItems.dispose();
    this._onDidCommitChatSessionItem.dispose();
  }
}
