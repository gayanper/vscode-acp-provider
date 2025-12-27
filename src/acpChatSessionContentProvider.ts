import * as vscode from "vscode";
import { AcpChatParticipant } from "./acpChatParticipant";
import { AcpClient, AcpPermissionHandler } from "./acpClient";
import { AgentRegistryEntry } from "./agentRegistry";
import { getAgentIdFromResource } from "./chatIdentifiers";
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

  onDidChangeChatSessionItems: vscode.Event<void> =
    new vscode.EventEmitter<void>().event;

  provideChatSessionItems(
    token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.ChatSessionItem[]> {
    return new Promise(async (resolve) => {
      const items: vscode.ChatSessionItem[] = [];
      resolve(items);
    });
  }

  onDidCommitChatSessionItem: vscode.Event<{
    original: vscode.ChatSessionItem;
    modified: vscode.ChatSessionItem;
  }> = new vscode.EventEmitter<{
    original: vscode.ChatSessionItem;
    modified: vscode.ChatSessionItem;
  }>().event;

  provideNewChatSessionItem?(
    options: { readonly request: vscode.ChatRequest; metadata?: any },
    token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.ChatSessionItem> {
    throw new Error("Method not implemented.");
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
    const state = await this.createSessionState(agent, resource);

    const sessionOptions: Record<string, vscode.ChatSessionProviderOptionItem> =
      {};
    const modeState = state.client.getSupportedModeState();
    if (modeState && modeState.availableModes.length > 0) {
      const defaultMode =
        modeState.availableModes.find(
          (m) => m.id === modeState.currentModeId,
        ) || modeState.availableModes[0];
      sessionOptions[VscodeSessionOptions.Mode] = {
        name: defaultMode.name,
        id: defaultMode.id,
        description: defaultMode.description || undefined,
      };
    }

    const modelState = state.client.getSupportedModelState();
    if (modelState && modelState.availableModels.length > 0) {
      const defaultModel =
        modelState.availableModels.find(
          (m) => m.modelId === modelState.currentModelId,
        ) || modelState.availableModels[0];
      sessionOptions[VscodeSessionOptions.Model] = {
        name: defaultModel.name,
        id: defaultModel.modelId,
        description: defaultModel.description || undefined,
      };
    }

    const session: vscode.ChatSession = {
      history: [],
      requestHandler: undefined,
      options: sessionOptions,
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

    const state = createSessionState(agent, vscodeResource, client, sessionId);
    this.options.participant.init(state);
    this.current = state;
    return state;
  }

  async provideChatSessionProviderOptions(
    token: vscode.CancellationToken,
  ): Promise<vscode.ChatSessionProviderOptions> {
    return {
      optionGroups: [],
    };
  }

  override dispose(): void {
    super.dispose();
  }
}
