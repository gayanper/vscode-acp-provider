// SPDX-License-Identifier: Apache-2.0
import fs from "fs";
import path from "path";
import * as vscode from "vscode";
import { AgentType } from "./types";

export type DiskSession = {
  sessionId: string;
  cwd: string;
  title: string;
  updatedAt: number;
};

export interface SessionDb extends vscode.Disposable {
  onDataChanged: vscode.Event<void>;
  listSessions(agent: AgentType, cwd: string): Promise<DiskSession[]>;
  upsertSession(agent: AgentType, info: DiskSession): Promise<void>;
  deleteSession(agent: AgentType, sessionId: string): Promise<void>;
  deleteAllSessions(cwd: string): Promise<void>;
}

type DiskSessionRecord = {
  agent_type: AgentType;
  session_id: string;
  cwd: string;
  title: string;
  updated_at: number;
};

type SessionStore = {
  version: 1;
  sessions: DiskSessionRecord[];
};

const STORE_VERSION: SessionStore["version"] = 1;

function getAcpStorePath(context: vscode.ExtensionContext): string {
  const acpDir = path.join(context.globalStorageUri.fsPath, ".acp");
  if (!fs.existsSync(acpDir)) {
    fs.mkdirSync(acpDir, { recursive: true });
  }
  return path.join(acpDir, "acp-sessions.json");
}

const createSessionDb = (
  context: vscode.ExtensionContext,
  logger: vscode.LogOutputChannel,
): SessionDb => {
  return new FileSessionDb(context, logger);
};

class FileSessionDb implements SessionDb {
  private readonly storePath: string;
  private cachedStore: SessionStore | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: vscode.LogOutputChannel,
  ) {
    this.storePath = getAcpStorePath(this.context);
  }

  // start event definitions --------------------------------------------------
  private readonly _onDataChanged: vscode.EventEmitter<void> =
    new vscode.EventEmitter<void>();
  onDataChanged: vscode.Event<void> = this._onDataChanged.event;
  // end event definitions -----------------------------------------------------

  async listSessions(agent: AgentType, cwd: string): Promise<DiskSession[]> {
    const store = await this.loadStore();
    return store.sessions
      .filter((session) => session.agent_type === agent && session.cwd === cwd)
      .sort((a, b) => b.updated_at - a.updated_at)
      .map((session) => ({
        sessionId: session.session_id,
        cwd: session.cwd,
        title: session.title,
        updatedAt: session.updated_at,
      }));
  }

  async upsertSession(agent: AgentType, info: DiskSession): Promise<void> {
    const store = await this.loadStore();
    const existing = store.sessions.find(
      (session) =>
        session.agent_type === agent && session.session_id === info.sessionId,
    );
    if (existing) {
      existing.cwd = info.cwd;
      existing.title = info.title;
      existing.updated_at = info.updatedAt;
    } else {
      store.sessions.push({
        agent_type: agent,
        session_id: info.sessionId,
        cwd: info.cwd,
        title: info.title,
        updated_at: info.updatedAt,
      });
    }

    await this.persistStore(store);
  }

  async deleteSession(agent: AgentType, sessionId: string): Promise<void> {
    const store = await this.loadStore();
    const nextSessions = store.sessions.filter(
      (session) =>
        !(session.agent_type === agent && session.session_id === sessionId),
    );
    if (nextSessions.length === store.sessions.length) {
      return;
    }
    store.sessions = nextSessions;
    await this.persistStore(store);
  }

  async deleteAllSessions(cwd: string): Promise<void> {
    const store = await this.loadStore();
    const nextSessions = store.sessions.filter(
      (session) => session.cwd !== cwd,
    );
    if (nextSessions.length === store.sessions.length) {
      return;
    }
    store.sessions = nextSessions;
    await this.persistStore(store);
  }

  dispose(): void {
    this._onDataChanged.dispose();
  }

  private async loadStore(): Promise<SessionStore> {
    if (this.cachedStore) {
      return this.cachedStore;
    }
    const store = await this.readStore();
    this.cachedStore = store;
    return store;
  }

  private async readStore(): Promise<SessionStore> {
    try {
      const raw = await fs.promises.readFile(this.storePath, "utf8");
      const parsed = JSON.parse(raw) as SessionStore;
      if (!parsed || parsed.version !== STORE_VERSION) {
        return { version: STORE_VERSION, sessions: [] };
      }
      return {
        version: STORE_VERSION,
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: STORE_VERSION, sessions: [] };
      }
      this.logger.warn(
        `Failed to read ACP session store: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { version: STORE_VERSION, sessions: [] };
    }
  }

  private async persistStore(
    store: SessionStore,
    notify: boolean = true,
  ): Promise<void> {
    const tempPath = `${this.storePath}.tmp`;
    const payload = JSON.stringify(store, null, 2);
    await fs.promises.writeFile(tempPath, payload, "utf8");

    try {
      await fs.promises.rename(tempPath, this.storePath);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "EEXIST" || err.code === "EPERM") {
        await fs.promises.unlink(this.storePath).catch(() => undefined);
        await fs.promises.rename(tempPath, this.storePath);
      } else {
        throw error;
      }
    }

    this.cachedStore = store;
    if (notify) {
      this._onDataChanged.fire();
    }
  }
}

export { createSessionDb };
