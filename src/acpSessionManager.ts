// SPDX-License-Identifier: Apache-2.0
import vscode, { ChatSessionItem, ChatSessionStatus } from "vscode";
import { AcpClient, AcpPermissionHandler, createAcpClient } from "./acpClient";
import { DiskSession, SessionDb } from "./acpSessionDb";
import { AgentRegistryEntry } from "./agentRegistry";
import { createSessionUri, decodeVscodeResource } from "./chatIdentifiers";
import { DisposableBase } from "./disposables";
import { getWorkspaceCwd } from "./permittedPaths";
import { TurnBuilder } from "./turnBuilder";
import { SessionModelState, SessionModeState } from "@agentclientprotocol/sdk";

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

export type Options = {
  modes: SessionModeState | null;
  models: SessionModelState | null;
};

export interface AcpSessionManager extends vscode.Disposable {
  onDidChangeSession: vscode.Event<{ original: Session; modified: Session }>;
  onDidOptionsChange: vscode.Event<void>;

  createOrGet(vscodeResource: vscode.Uri): Promise<{
    session: Session;
    history?: Array<vscode.ChatRequestTurn2 | vscode.ChatResponseTurn2>;
  }>;
  get(vscodeResource: vscode.Uri): Promise<DiskSession | undefined>;
  getActive(vscodeResource: vscode.Uri): Session | undefined;
  list(): Promise<ChatSessionItem[]>;
  syncSessionState(
    vscodeResource: vscode.Uri,
    modified: Session,
  ): Promise<void>;
  getOptions(): Promise<Options>;
}

export function createAcpSessionManager(
  sessionDb: SessionDb,
  agent: AgentRegistryEntry,
  permissionHandler: AcpPermissionHandler,
  logger: vscode.LogOutputChannel,
  clientProvider?: () => AcpClient,
): AcpSessionManager {
  return new SessionManager(
    sessionDb,
    agent,
    permissionHandler,
    logger,
    clientProvider,
  );
}

class SessionManager extends DisposableBase implements AcpSessionManager {
  private readonly client: AcpClient;
  constructor(
    private readonly sessionDb: SessionDb,
    private readonly agent: AgentRegistryEntry,
    readonly permissionHandler: AcpPermissionHandler,
    private readonly logger: vscode.LogOutputChannel,
    clientProvider: () => AcpClient = () =>
      createAcpClient(agent, permissionHandler, logger),
  ) {
    super();
    this.client = this._register(clientProvider());

    this._register(
      this.client.onDidOptionsChanged(() => {
        this._onDidChangeOptions.fire();
      }),
    );

    this._register(
      this.sessionDb.onDataChanged(async () => {
        this.logger.info(
          `Session DB data changed event received for agent ${this.agent.id}`,
        );
        await this.loadDiskSessionsIfNeeded(true);
      }),
    );
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

  private readonly _onDidChangeOptions: vscode.EventEmitter<void> =
    new vscode.EventEmitter<void>();
  onDidOptionsChange: vscode.Event<void> = this._onDidChangeOptions.event;
  // end event definitions --------------------------------------------------

  private diskSessions: Map<string, DiskSession> | null = null;
  private activeSessions: Map<string, Session> = new Map();

  private createSessionUri(sessionId: string): vscode.Uri {
    return createSessionUri(this.agent.id, sessionId);
  }

  async createOrGet(vscodeResource: vscode.Uri): Promise<{
    session: Session;
    history?: Array<vscode.ChatRequestTurn2 | vscode.ChatResponseTurn2>;
  }> {
    const decodedResource = decodeVscodeResource(vscodeResource);

    if (decodedResource.isUntitled) {
      if (this.activeSessions.has(decodedResource.sessionId)) {
        return {
          session: this.activeSessions.get(decodedResource.sessionId)!,
        };
      } else {
        this.logger.info(
          `Creating new untitled session for resource ${vscodeResource.toString()}`,
        );

        const acpSession = await this.client.createSession(
          getWorkspaceCwd(),
          this.agent.mcpServers,
        );
        const session = new Session(
          this.agent,
          vscodeResource,
          this.client,
          acpSession.sessionId,
          {
            modeId: acpSession.modes?.currentModeId || "",
            modelId: acpSession.models?.currentModelId || "",
          },
        );
        this.activeSessions.set(decodedResource.sessionId, session);

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
    } else {
      const existingSession = await this.get(vscodeResource);
      if (existingSession) {
        this.logger.debug(
          `Session found on disk for resource ${vscodeResource.toString()}`,
        );
        const response = await this.client.loadSession(
          existingSession.sessionId,
          existingSession.cwd,
          this.agent.mcpServers,
        );

        const session = new Session(
          this.agent,
          vscodeResource,
          this.client,
          existingSession.sessionId,
          {
            modeId: response.modeId || "",
            modelId: response.modelId || "",
          },
        );
        this.activeSessions.set(decodedResource.sessionId, session);

        const turnBuilder = new TurnBuilder(this.agent.id);
        response.notifications.forEach((notification) =>
          turnBuilder.processNotification(notification),
        );
        const history = turnBuilder.getTurns();

        this.logger.debug(
          `Resuming session with ${history.length} history turns from disk session.`,
        );
        return { session, history };
      } else {
        throw new Error(
          `No existing session found for resource ${vscodeResource.toString()}`,
        );
      }
    }
  }

  async get(vscodeResource: vscode.Uri): Promise<DiskSession | undefined> {
    const decoded = decodeVscodeResource(vscodeResource);
    await this.loadDiskSessionsIfNeeded();

    const session = this.diskSessions?.get(decoded.sessionId);
    return session;
  }

  getActive(vscodeResource: vscode.Uri): Session | undefined {
    const decodedResource = decodeVscodeResource(vscodeResource);
    return this.activeSessions.get(decodedResource.sessionId);
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
          created: Number(session.updatedAt),
        },
      });
    }
    return chatSessionItems;
  }

  async syncSessionState(
    vscodeResource: vscode.Uri,
    modified: Session,
  ): Promise<void> {
    const decoded = decodeVscodeResource(vscodeResource);
    const session = this.activeSessions.get(decoded.sessionId);

    if (!session) {
      this.logger.warn(
        `No active session found for resource ${vscodeResource.toString()} to sync state.`,
      );
      return;
    }

    this.activeSessions.set(decoded.sessionId, modified);
    this._onDidChangeSession.fire({
      original: session,
      modified: modified,
    });
  }

  async getOptions(): Promise<Options> {
    const modes = this.client.getSupportedModeState();
    const models = this.client.getSupportedModelState();
    return { modes, models };
  }

  private async loadDiskSessionsIfNeeded(
    reload: boolean = false,
  ): Promise<void> {
    if (!this.diskSessions || reload) {
      const data = await this.sessionDb.listSessions(
        this.agent.id,
        getWorkspaceCwd(),
      );
      this.diskSessions = new Map<string, DiskSession>(
        data.map((s) => [s.sessionId, s]),
      );
    }
  }

  dispose(): void {
    this.activeSessions.clear();
    this.diskSessions?.clear();
    this._onDidChangeSession.dispose();
  }
}
