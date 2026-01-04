// SPDX-License-Identifier: Apache-2.0
import fs from "fs";
import { DatabaseSync } from "node:sqlite";
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
  listSessions(agent: AgentType): Promise<DiskSession[]>;
  upsertSession(agent: AgentType, info: DiskSession): Promise<void>;
  deleteSession(agent: AgentType, sessionId: string): Promise<void>;
}

function getAcpDbFile(context: vscode.ExtensionContext): string {
  const acpDir = path.join(context.globalStorageUri.fsPath, ".acp");
  if (!fs.existsSync(acpDir)) {
    fs.mkdirSync(acpDir, { recursive: true });
  }
  return path.join(acpDir, "acp-sessions.db");
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_type TEXT NOT NULL,
  session_id TEXT NOT NULL,
  cwd TEXT,
  title TEXT,
  updated_at DATETIME NOT NULL,
  UNIQUE(agent_type, session_id)
);`;

const createSessionDb = (
  context: vscode.ExtensionContext,
  logger: vscode.LogOutputChannel,
): SessionDb => {
  return new SqlLiteSessionDb(context, logger);
};

class SqlLiteSessionDb implements SessionDb {
  private db?: DatabaseSync;
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: vscode.LogOutputChannel,
  ) {
    this.init();
  }

  // start event definitions --------------------------------------------------
  private readonly _onDataChanged: vscode.EventEmitter<void> =
    new vscode.EventEmitter<void>();
  onDataChanged: vscode.Event<void> = this._onDataChanged.event;
  // end event definitions -----------------------------------------------------

  private init() {
    const dbPath = getAcpDbFile(this.context);
    this.logger.info(`Using ACP session database at: ${dbPath}`);

    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
  }

  async listSessions(agent: AgentType): Promise<DiskSession[]> {
    const rows = this.db!.prepare(
      "SELECT session_id AS sessionId, cwd, title, updated_at AS updatedAt FROM sessions WHERE agent_type=? ORDER BY updated_at DESC",
    ).all(agent);
    return rows.map((row: any) => ({
      sessionId: row.sessionId,
      cwd: row.cwd,
      title: row.title,
      updatedAt: row.updatedAt,
    }));
  }

  async upsertSession(agent: AgentType, info: DiskSession): Promise<void> {
    const existing = this.db!.prepare(
      "SELECT COUNT(*) AS count FROM sessions WHERE agent_type=? AND session_id=?",
    ).get(agent, info.sessionId) as { count: number };

    if (existing.count > 0) {
      await this.updateSession(agent, info);
    } else {
      await this.insertSession(agent, info);
    }
  }

  private async insertSession(
    agent: AgentType,
    info: DiskSession,
  ): Promise<void> {
    const resp = this.db!.prepare(
      "INSERT OR IGNORE INTO sessions (agent_type, session_id, cwd, title, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run(agent, info.sessionId, info.cwd, info.title, info.updatedAt);
    if (resp.changes > 0) {
      this._onDataChanged.fire();
    }
  }

  private async updateSession(
    agent: AgentType,
    info: DiskSession,
  ): Promise<void> {
    const resp = this.db!.prepare(
      "UPDATE sessions SET cwd=?, title=?, updated_at=? WHERE agent_type=? AND session_id=?",
    ).run(info.cwd, info.title, info.updatedAt, agent, info.sessionId);
    if (resp.changes > 0) {
      this._onDataChanged.fire();
    }
  }

  async deleteSession(agent: AgentType, sessionId: string): Promise<void> {
    const resp = this.db!.prepare(
      "DELETE FROM sessions WHERE agent_type=? AND session_id=?",
    ).run(agent, sessionId);
    if (resp.changes > 0) {
      this._onDataChanged.fire();
    }
  }

  dispose() {
    this.db?.close();
  }
}

export { createSessionDb };
