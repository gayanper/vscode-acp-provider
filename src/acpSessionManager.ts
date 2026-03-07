// SPDX-License-Identifier: Apache-2.0
import vscode, { ChatSessionItem, ChatSessionStatus } from "vscode";
import { AcpClient, AcpPermissionHandler, createAcpClient } from "./acpClient";
import { DiskSession, SessionDb } from "./acpSessionDb";
import { AcpSessionSyncer } from "./acpSessionSyncer";
import { AgentRegistryEntry } from "./agentRegistry";
import { createSessionUri, decodeVscodeResource } from "./chatIdentifiers";
import { DisposableBase } from "./disposables";
import { getWorkspaceCwd } from "./permittedPaths";
import { TurnBuilder } from "./turnBuilder";
import {
  AvailableCommand,
  SessionConfigOption,
  SessionModelState,
  SessionModeState,
  type SessionNotification,
} from "@agentclientprotocol/sdk";

export class Session {
  private _status: ChatSessionStatus;
  private _title: string;
  private _updatedAt: number;
  pendingRequest?: {
    cancellation: vscode.CancellationTokenSource;
    permissionContext?: vscode.Disposable;
  };

  /** Latest context window usage reported via `usage_update` notifications. */
  contextWindowUsed?: number;
  /** Context window capacity reported via `usage_update` notifications. */
  contextWindowSize?: number;

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

  markAsNeedsInput(): void {
    this._status = ChatSessionStatus.NeedsInput;
    this._updatedAt = Date.now();
  }
}

export type Options = {
  modes: SessionModeState | null;
  models: SessionModelState | null;
  thoughtLevelOptions: SessionConfigOption[] | null;
};

export interface AcpSessionManager extends vscode.Disposable {
  onDidChangeSession: vscode.Event<{ original: Session; modified: Session }>;
  onDidOptionsChange: vscode.Event<void>;
  onDidCurrentModeChange: vscode.Event<{
    resource: vscode.Uri;
    modeId: string;
  }>;
  onDidCurrentModelChange: vscode.Event<{
    resource: vscode.Uri;
    modelId: string;
  }>;

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
  getAvailableCommands(sessionId: string): AvailableCommand[];
  closeSession(vscodeResource: vscode.Uri): void;
  createSessionUri(session: Session): vscode.Uri;
}

export function createAcpSessionManager(
  sessionDb: SessionDb,
  agent: AgentRegistryEntry,
  permissionHandler: AcpPermissionHandler,
  logger: vscode.LogOutputChannel,
  clientProvider?: () => AcpClient,
  sessionSyncer?: AcpSessionSyncer,
): AcpSessionManager {
  return new SessionManager(
    sessionDb,
    agent,
    permissionHandler,
    logger,
    clientProvider,
    sessionSyncer,
  );
}

class SessionManager extends DisposableBase implements AcpSessionManager {
  private readonly clientFactory: () => AcpClient;
  constructor(
    private readonly sessionDb: SessionDb,
    private readonly agent: AgentRegistryEntry,
    readonly permissionHandler: AcpPermissionHandler,
    private readonly logger: vscode.LogOutputChannel,
    clientFactory: () => AcpClient = () =>
      createAcpClient(agent, permissionHandler, logger),
    private readonly sessionSyncer?: AcpSessionSyncer,
  ) {
    super();
    this.clientFactory = clientFactory;

    this._register(
      this.sessionDb.onDataChanged(async () => {
        this.logger.debug(
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

  private readonly _onDidCurrentModeChange: vscode.EventEmitter<{
    resource: vscode.Uri;
    modeId: string;
  }> = new vscode.EventEmitter<{ resource: vscode.Uri; modeId: string }>();
  onDidCurrentModeChange: vscode.Event<{
    resource: vscode.Uri;
    modeId: string;
  }> = this._onDidCurrentModeChange.event;

  private readonly _onDidCurrentModelChange: vscode.EventEmitter<{
    resource: vscode.Uri;
    modelId: string;
  }> = new vscode.EventEmitter<{ resource: vscode.Uri; modelId: string }>();
  onDidCurrentModelChange: vscode.Event<{
    resource: vscode.Uri;
    modelId: string;
  }> = this._onDidCurrentModelChange.event;
  // end event definitions --------------------------------------------------

  private diskSessions: Map<string, DiskSession> | null = null;
  private activeSessions: Map<string, Session> = new Map();
  private lastKnownModelId: string | null = null;
  private availableCommands: Map<string, AvailableCommand[]> = new Map();
  private readonly sessionSubscriptions = new Map<
    string,
    vscode.Disposable[]
  >();
  private cachedOptions: Options = {
    modes: null,
    models: null,
    thoughtLevelOptions: null,
  };

  createSessionUri(session: Session): vscode.Uri {
    const uri = createSessionUri(this.agent.id, session.acpSessionId);
    // find and replace the session with new session id in active sessions
    const entry = Array.from(this.activeSessions).find(
      (s) => s[1].acpSessionId === session.acpSessionId,
    );
    if (entry) {
      this.activeSessions.delete(entry[0]);
      const subs = this.sessionSubscriptions.get(entry[0]);
      if (subs) {
        this.sessionSubscriptions.delete(entry[0]);
        this.sessionSubscriptions.set(session.acpSessionId, subs);
      }
      this.logger.debug(
        `Replaced session with new session id ${session.acpSessionId}`,
      );
    } else {
      this.logger.debug(
        `Created session URI for session id ${session.acpSessionId} without replacement`,
      );
    }
    this.activeSessions.set(session.acpSessionId, session);
    return uri;
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

        const client = this.clientFactory();
        this.sessionSubscriptions.set(decodedResource.sessionId, [
          client.onSessionUpdate((update) =>
            this.handlePreChatSessionUpdate(update),
          ),
          client.onDidOptionsChanged(() => {
            const newOptions = this.buildOptions(client);
            this.detectAndFireModelChange(newOptions);
            this.cachedOptions = newOptions;
            this._onDidChangeOptions.fire();
          }),
        ]);

        const acpSession = await client.createSession(
          getWorkspaceCwd(),
          this.agent.mcpServers,
        );
        this.sessionSyncer
          ?.sync(this.agent.id, client)
          .catch((e) =>
            this.logger.warn(`[acpSessionSyncer] Sync failed: ${e}`),
          );
        this.cachedOptions = this.buildOptions(client);

        const session = new Session(
          this.agent,
          vscodeResource,
          client,
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

        const client = this.clientFactory();
        this.sessionSubscriptions.set(decodedResource.sessionId, [
          client.onSessionUpdate((update) =>
            this.handlePreChatSessionUpdate(update),
          ),
          client.onDidOptionsChanged(() => {
            const newOptions = this.buildOptions(client);
            this.detectAndFireModelChange(newOptions);
            this.cachedOptions = newOptions;
            this._onDidChangeOptions.fire();
          }),
        ]);

        const response = await client.loadSession(
          existingSession.sessionId,
          existingSession.cwd,
          this.agent.mcpServers,
        );
        this.sessionSyncer
          ?.sync(this.agent.id, client)
          .catch((e) =>
            this.logger.warn(`[acpSessionSyncer] Sync failed: ${e}`),
          );
        this.cachedOptions = this.buildOptions(client);

        const session = new Session(
          this.agent,
          vscodeResource,
          client,
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
      const resource = createSessionUri(this.agent.id, sessionId);

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
    return this.cachedOptions;
  }

  private buildOptions(client: AcpClient): Options {
    return {
      modes: client.getSupportedModeState(),
      models: client.getSupportedModelState(),
      thoughtLevelOptions: client
        .getConfigOptions()
        .filter((o) => o.category === "thought_level"),
    };
  }

  getAvailableCommands(sessionId: string): AvailableCommand[] {
    return this.availableCommands.get(sessionId) ?? [];
  }

  private detectAndFireModelChange(newOptions: Options): void {
    const newModelId = newOptions.models?.currentModelId ?? null;
    if (newModelId !== null && newModelId !== this.lastKnownModelId) {
      this.lastKnownModelId = newModelId;
      for (const session of this.activeSessions.values()) {
        this._onDidCurrentModelChange.fire({
          resource: session.vscodeResource,
          modelId: newModelId,
        });
      }
    }
  }

  // this handler must handle none-chat session messages
  private handlePreChatSessionUpdate(notification: SessionNotification): void {
    const update = notification.update;
    if (update.sessionUpdate === "available_commands_update") {
      this.logger.info(`Received ${update.availableCommands.length} commands`);
      this.setAvailableCommands(
        notification.sessionId,
        update.availableCommands,
      );
    } else if (update.sessionUpdate === "current_mode_update") {
      for (const session of this.activeSessions.values()) {
        if (session.acpSessionId === notification.sessionId) {
          this._onDidCurrentModeChange.fire({
            resource: session.vscodeResource,
            modeId: update.currentModeId,
          });
          break;
        }
      }
    }
  }

  private setAvailableCommands(
    sessionId: string,
    commands: AvailableCommand[],
  ): void {
    this.availableCommands.set(sessionId, commands);
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

  private disposeSessionClient(sessionId: string, session: Session): void {
    session.pendingRequest?.cancellation.cancel();
    session.pendingRequest?.permissionContext?.dispose();
    session.pendingRequest = undefined;

    this.sessionSubscriptions.get(sessionId)?.forEach((s) => s.dispose());
    this.sessionSubscriptions.delete(sessionId);

    session.client.dispose().catch(() => {
      /* noop — best-effort process kill */
    });
  }

  closeSession(vscodeResource: vscode.Uri): void {
    const decoded = decodeVscodeResource(vscodeResource);
    const session = this.activeSessions.get(decoded.sessionId);
    if (!session) {
      return;
    }
    session.markAsFailed();
    this._onDidChangeSession.fire({ original: session, modified: session });

    this.disposeSessionClient(decoded.sessionId, session);
    this.activeSessions.delete(decoded.sessionId);
    this.availableCommands.delete(decoded.sessionId);
    this.logger.info(`Closed session and killed process: ${decoded.sessionId}`);
  }

  dispose(): void {
    super.dispose();
    for (const [sessionId, session] of this.activeSessions) {
      this.disposeSessionClient(sessionId, session);
    }
    this.activeSessions.clear();
    this.sessionSubscriptions.clear();
    this.diskSessions?.clear();
    this.availableCommands.clear();
    this._onDidChangeSession.dispose();
    this._onDidChangeOptions.dispose();
    this._onDidCurrentModeChange.dispose();
    this._onDidCurrentModelChange.dispose();
  }
}
