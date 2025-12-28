import vscode, {
  ChatSessionItem,
  ChatSessionStatus,
  WorkspaceConfiguration,
} from "vscode";
import { AcpClient, AcpPermissionHandler } from "./acpClient";
import { AgentRegistryEntry } from "./agentRegistry";
import { createSessionType } from "./chatIdentifiers";
import { DisposableBase } from "./disposables";
import { getWorkspaceCwd } from "./permittedPaths";
import { SessionInfo } from "@agentclientprotocol/sdk";

export class Session {
  private _status: ChatSessionStatus;
  pendingRequest?: {
    cancellation: vscode.CancellationTokenSource;
    permissionContext?: vscode.Disposable;
  };

  constructor(
    readonly agent: AgentRegistryEntry,
    readonly vscodeResource: vscode.Uri,
    readonly client: AcpClient,
    readonly acpSessionId: string,
    readonly defaultChatOptions: { modeId: string; modelId: string },
  ) {
    this._status = ChatSessionStatus.InProgress;
    this.pendingRequest = undefined;
  }

  get status(): ChatSessionStatus {
    return this._status;
  }

  markAsInProgress(): void {
    this._status = ChatSessionStatus.InProgress;
  }

  markAsCompleted(): void {
    this._status = ChatSessionStatus.Completed;
  }

  markAsFailed(): void {
    this._status = ChatSessionStatus.Failed;
  }
}

export interface AcpSessionManager extends vscode.Disposable {
  onDidChangeSession: vscode.Event<{ original: Session; modified: Session }>;

  getDefault(): Promise<Session>;
  create(vscodeResource: vscode.Uri): Promise<Session>;
  get(vscodeResource: vscode.Uri): Session | undefined;
  list(): Promise<ChatSessionItem[]>;
}

export function createAcpSessionManager(
  agent: AgentRegistryEntry,
  permissionHandler: AcpPermissionHandler,
  logger: vscode.LogOutputChannel,
): AcpSessionManager {
  return new SessionManager(agent, permissionHandler, logger);
}

const DEFAULT_SESSION_ID = "default";

class SessionManager extends DisposableBase implements AcpSessionManager {
  private readonly client: AcpClient;
  constructor(
    private readonly agent: AgentRegistryEntry,
    readonly permissionHandler: AcpPermissionHandler,
    private readonly logger: vscode.LogOutputChannel,
  ) {
    super();
    this.client = new AcpClient(agent, permissionHandler, logger);
  }

  // start event definitions --------------------------------------------------
  private readonly _onDidChangeSession: vscode.EventEmitter<{
    original: Session;
    modified: Session;
  }> = new vscode.EventEmitter<{
    original: Session;
    modified: Session;
  }>();
  onDidChangeSession: vscode.Event<{ original: Session; modified: Session }> =
    this._onDidChangeSession.event;
  // end event definitions --------------------------------------------------

  private activeSessions: Map<string, Session> = new Map();

  private createSessionResourceUri(sessionId: string): vscode.Uri {
    return vscode.Uri.parse(
      `${createSessionType(this.agent.id)}://${sessionId}`,
    );
  }

  private createSessionKey(vscodeResource: vscode.Uri): string {
    return vscodeResource.toString();
  }

  async getDefault(cwd: string = getWorkspaceCwd()): Promise<Session> {
    let session = this.activeSessions.get(
      this.createSessionKey(this.createSessionResourceUri(DEFAULT_SESSION_ID)),
    );
    if (session) {
      return session;
    }

    // create new default session
    this.logger.info(`Creating default session for agent ${this.agent.id}`);
    const acpSession = await this.client.createSession(cwd);

    session = new Session(
      this.agent,
      this.createSessionResourceUri(DEFAULT_SESSION_ID),
      this.client,
      acpSession.sessionId,
      {
        modeId: acpSession.modes?.currentModeId || "",
        modelId: acpSession.models?.currentModelId || "",
      },
    );

    this.activeSessions.set(DEFAULT_SESSION_ID, session);
    return session;
  }

  async create(vscodeResource: vscode.Uri): Promise<Session> {
    // check if a session exist for the given resource
    const key = this.createSessionKey(vscodeResource);
    let session = this.activeSessions.get(key);
    if (session) {
      this.logger.debug(
        `Reusing existing session for resource ${vscodeResource.toString()}`,
      );
      return session;
    }

    // check if the default session exists, if so use it and update the map
    const defaultKey = this.createSessionKey(
      this.createSessionResourceUri(DEFAULT_SESSION_ID),
    );
    session = this.activeSessions.get(defaultKey);
    if (session) {
      this.logger.debug(
        `Reusing default session for resource ${vscodeResource.toString()}`,
      );
      this.activeSessions.delete(defaultKey);
      this.activeSessions.set(key, session);
      return session;
    }

    // create new session
    this.logger.info(
      `Creating new session for resource ${vscodeResource.toString()}`,
    );
    const acpSession = await this.client.createSession(getWorkspaceCwd());
    const newResource = this.createSessionResourceUri(acpSession.sessionId);
    const newKey = this.createSessionKey(newResource);

    session = new Session(
      this.agent,
      newResource,
      this.client,
      acpSession.sessionId,
      {
        modeId: acpSession.modes?.currentModeId || "",
        modelId: acpSession.models?.currentModelId || "",
      },
    );

    const expectedOriginal = new Session(
      session.agent,
      vscodeResource,
      session.client,
      session.acpSessionId,
      session.defaultChatOptions,
    );

    this._onDidChangeSession.fire({
      original: expectedOriginal,
      modified: session,
    });
    this.activeSessions.set(newKey, session);
    return session;
  }

  get(vscodeResource: vscode.Uri): Session | undefined {
    const key = vscodeResource.toString();
    return this.activeSessions.get(key);
  }

  async list(): Promise<ChatSessionItem[]> {
    const diskSessions: SessionInfo[] =
      await this.client.listSessions(getWorkspaceCwd());

    const chatSessionItems: ChatSessionItem[] = [];
    for (const diskSession of diskSessions) {
      const resource = this.createSessionResourceUri(diskSession.sessionId);
      const key = this.createSessionKey(resource);
      const inProgressSession = this.activeSessions.get(key);

      chatSessionItems.push({
        label: diskSession.title || diskSession.sessionId,
        status: inProgressSession
          ? ChatSessionStatus.InProgress
          : ChatSessionStatus.Completed,
        resource: resource,
      });
    }
    return chatSessionItems;
  }
}
