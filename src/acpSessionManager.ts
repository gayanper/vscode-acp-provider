import { SessionInfo } from "@agentclientprotocol/sdk";
import vscode, { ChatSessionItem, ChatSessionStatus } from "vscode";
import { AcpClient, AcpPermissionHandler } from "./acpClient";
import { AgentRegistryEntry } from "./agentRegistry";
import { createSessionUri, getSessionId } from "./chatIdentifiers";
import { DisposableBase } from "./disposables";
import { getWorkspaceCwd } from "./permittedPaths";
import { TurnBuilder } from "./turnBuilder";
import { SessionDb } from "./acpSessionDb";

export class Session {
  private _status: ChatSessionStatus;
  private _title: string;
  private _updatedAt: number;
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
    readonly cwd: string = getWorkspaceCwd(),
  ) {
    this._status = ChatSessionStatus.InProgress;
    this.pendingRequest = undefined;
    this._title = `Session [${agent.id}] ${acpSessionId}`;
    this._updatedAt = Date.now();
  }

  get title(): string {
    return this._title;
  }

  set title(value: string) {
    this._title = value;
  }
  get updatedAt(): number {
    return this._updatedAt;
  }

  get status(): ChatSessionStatus {
    return this._status;
  }

  markAsInProgress(): void {
    this._status = ChatSessionStatus.InProgress;
    this._updatedAt = Date.now();
  }

  markAsCompleted(): void {
    this._status = ChatSessionStatus.Completed;
    this._updatedAt = Date.now();
  }

  markAsFailed(): void {
    this._status = ChatSessionStatus.Failed;
    this._updatedAt = Date.now();
  }
}

export interface AcpSessionManager extends vscode.Disposable {
  onDidChangeSession: vscode.Event<{ original: Session; modified: Session }>;

  getDefault(): Promise<Session>;
  createOrGet(vscodeResource: vscode.Uri): Promise<{
    session: Session;
    history?: Array<vscode.ChatRequestTurn2 | vscode.ChatResponseTurn2>;
  }>;
  get(vscodeResource: vscode.Uri): Promise<Session | undefined>;
  list(): Promise<ChatSessionItem[]>;
}

export function createAcpSessionManager(
  sessionDb: SessionDb,
  agent: AgentRegistryEntry,
  permissionHandler: AcpPermissionHandler,
  logger: vscode.LogOutputChannel,
): AcpSessionManager {
  return new SessionManager(sessionDb, agent, permissionHandler, logger);
}

const DEFAULT_SESSION_ID = "default";

class SessionManager extends DisposableBase implements AcpSessionManager {
  private readonly client: AcpClient;
  constructor(
    private readonly sessionDb: SessionDb,
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

  private defaultSession: Session | null = null;
  private diskSessions: Map<string, SessionInfo> | null = null;

  private createSessionUri(sessionId: string): vscode.Uri {
    return createSessionUri(this.agent.id, sessionId);
  }

  private createSessionKey(vscodeResource: vscode.Uri): string {
    return vscodeResource.toString();
  }

  async getDefault(cwd: string = getWorkspaceCwd()): Promise<Session> {
    if (this.defaultSession) {
      return this.defaultSession;
    }

    // create new default session
    this.logger.info(`Creating default session for agent ${this.agent.id}`);
    const acpSession = await this.client.createSession(cwd);

    this.defaultSession = new Session(
      this.agent,
      this.createSessionUri(DEFAULT_SESSION_ID),
      this.client,
      acpSession.sessionId,
      {
        modeId: acpSession.modes?.currentModeId || "",
        modelId: acpSession.models?.currentModelId || "",
      },
    );

    return this.defaultSession;
  }

  async createOrGet(vscodeResource: vscode.Uri): Promise<{
    session: Session;
    history?: Array<vscode.ChatRequestTurn2 | vscode.ChatResponseTurn2>;
  }> {
    const doesExist = async () => {
      const sessionId = getSessionId(vscodeResource);
      await this.loadDiskSessionsIfNeeded();
      return this.diskSessions?.has(sessionId);
    };

    if (await doesExist()) {
      // check the disk sessions
      await this.loadDiskSessionsIfNeeded();
      const sessionId = getSessionId(vscodeResource);
      if (this.diskSessions?.has(sessionId)) {
        this.logger.debug(
          `Session found on disk for resource ${vscodeResource.toString()}`,
        );
        // create a new session object to represent this disk session
        const diskSession = this.diskSessions.get(sessionId)!;
        const response = await this.client.loadSession(
          diskSession.sessionId,
          diskSession.cwd,
        );

        const session = new Session(
          this.agent,
          vscodeResource,
          this.client,
          diskSession.sessionId,
          {
            modeId: response.modeId || "",
            modelId: response.modelId || "",
          },
        );

        const turnBuilder = new TurnBuilder(this.agent.id);
        response.notifications.forEach((notification) =>
          turnBuilder.processNotification(notification),
        );
        const history = turnBuilder.getTurns();

        return { session, history };
      }
      throw new Error(
        `Session unexpectedly found during creation for resource ${vscodeResource.toString()}`,
      );
    } else {
      // check if the default session exists, if so use it and update the map
      if (this.defaultSession) {
        this.logger.debug(
          `Reusing default session for resource ${vscodeResource.toString()}`,
        );
        const resource = this.createSessionUri(
          this.defaultSession.acpSessionId,
        );
        const newSession = new Session(
          this.defaultSession.agent,
          resource,
          this.defaultSession.client,
          this.defaultSession.acpSessionId,
          this.defaultSession.defaultChatOptions,
        );

        this._onDidChangeSession.fire({
          original: this.defaultSession,
          modified: newSession,
        });

        return { session: newSession };
      }

      // create new session
      this.logger.info(
        `Creating new session for resource ${vscodeResource.toString()}`,
      );
      const acpSession = await this.client.createSession(getWorkspaceCwd());
      const resource = this.createSessionUri(acpSession.sessionId);
      const key = this.createSessionKey(resource);

      const session = new Session(
        this.agent,
        resource,
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
      return { session };
    }
  }

  async get(vscodeResource: vscode.Uri): Promise<Session | undefined> {
    const key = this.createSessionKey(vscodeResource);
    await this.loadDiskSessionsIfNeeded();

    const session = this.diskSessions?.get(key);
    if (!session) {
      return undefined;
    }
    return new Session(
      this.agent,
      vscodeResource,
      this.client,
      session.sessionId,
      {
        modeId: "",
        modelId: "",
      },
    );
  }

  async list(): Promise<ChatSessionItem[]> {
    await this.loadDiskSessionsIfNeeded();
    if (!this.diskSessions) {
      return [];
    }

    const chatSessionItems: ChatSessionItem[] = [];
    for (const [sessionId, session] of this.diskSessions) {
      const resource = this.createSessionUri(sessionId);

      chatSessionItems.push({
        label: session.title || session.sessionId,
        status: ChatSessionStatus.Completed,
        resource: resource,
        timing: {
          startTime: Number(session.updatedAt),
        },
      });
    }
    return chatSessionItems;
  }

  private async loadDiskSessionsIfNeeded(
    reload: boolean = false,
  ): Promise<void> {
    if (!this.diskSessions || reload) {
      const data = await this.sessionDb.listSessions(this.agent.id);
      this.diskSessions = new Map<string, SessionInfo>(
        data.map((s) => [
          s.sessionId,
          {
            cwd: s.cwd,
            sessionId: s.sessionId,
            title: s.title,
            updatedAt: String(s.updatedAt),
          } as SessionInfo,
        ]),
      );
    }
  }
}
