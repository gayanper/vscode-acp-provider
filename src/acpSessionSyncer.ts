// SPDX-License-Identifier: Apache-2.0
import * as vscode from "vscode";
import { AcpClient } from "./acpClient";
import { DiskSession, SessionDb } from "./acpSessionDb";
import { AgentType } from "./types";

export interface AcpSessionSyncer extends vscode.Disposable {
  sync(agentType: AgentType, client: AcpClient): Promise<void>;
}

export function createAcpSessionSyncer(
  sessionDb: SessionDb,
  logger: vscode.LogOutputChannel,
): AcpSessionSyncer {
  return new AcpSessionSyncerImpl(sessionDb, logger);
}

class AcpSessionSyncerImpl implements AcpSessionSyncer {
  private readonly syncedAgents = new Set<AgentType>();

  constructor(
    private readonly sessionDb: SessionDb,
    private readonly logger: vscode.LogOutputChannel,
  ) {}

  async sync(agentType: AgentType, client: AcpClient): Promise<void> {
    const caps = client.getCapabilities();

    if (!caps.loadSession) {
      this.logger.debug(
        `[acpSessionSyncer] Agent ${agentType} does not have session load capability; skipping sync`,
      );
      return;
    }

    if (!caps.sessionCapabilities?.list) {
      this.logger.debug(
        `[acpSessionSyncer] Agent ${agentType} does not support session listing; skipping sync`,
      );
      return;
    }

    if (this.syncedAgents.has(agentType)) {
      return;
    }
    this.syncedAgents.add(agentType);

    this.logger.info(
      `[acpSessionSyncer] Syncing native ACP sessions for agent ${agentType}`,
    );

    let cursor: string | undefined;
    let imported = 0;

    do {
      const response = await client.listNativeSessions(cursor);

      for (const session of response.sessions) {
        const alreadyExists = await this.sessionDb.hasSession(
          agentType,
          session.sessionId,
        );
        if (alreadyExists) {
          continue;
        }

        const diskSession: DiskSession = {
          sessionId: session.sessionId,
          cwd: session.cwd,
          title: session.title ?? session.sessionId,
          updatedAt: session.updatedAt
            ? Date.parse(session.updatedAt)
            : Date.now(),
        };
        await this.sessionDb.upsertSession(agentType, diskSession);
        imported++;
      }

      cursor = response.nextCursor ?? undefined;
    } while (cursor);

    this.logger.info(
      `[acpSessionSyncer] Imported ${imported} new native sessions for agent ${agentType}`,
    );
  }

  dispose() {}
}
