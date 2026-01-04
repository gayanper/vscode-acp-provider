// SPDX-License-Identifier: Apache-2.0
import vscode from "vscode";
import { AcpSessionManager } from "./acpSessionManager";
import { DisposableBase } from "./disposables";
import { SessionDb } from "./acpSessionDb";

export function createAcpChatSessionItemProvider(
  sessionManager: AcpSessionManager,
  sessionDb: SessionDb,
  logger: vscode.LogOutputChannel,
): vscode.ChatSessionItemProvider & vscode.Disposable {
  return new AcpChatSessionItemProvider(sessionManager, sessionDb, logger);
}

class AcpChatSessionItemProvider
  extends DisposableBase
  implements vscode.ChatSessionItemProvider
{
  constructor(
    private readonly sessionManager: AcpSessionManager,
    private readonly sessionDb: SessionDb,
    private readonly logger: vscode.LogOutputChannel,
  ) {
    super();
    this._register(
      this.sessionManager.onDidChangeSession(({ original, modified }) => {
        const originalItem: vscode.ChatSessionItem = {
          resource: original.vscodeResource,
          label: original.acpSessionId,
        };

        const modifiedItem: vscode.ChatSessionItem = {
          resource: modified.vscodeResource,
          label: modified.acpSessionId,
        };

        this._onDidCommitChatSessionItem.fire({
          original: originalItem,
          modified: modifiedItem,
        });

        this.sessionDb
          .upsertSession(original.agent.id, {
            sessionId: modified.acpSessionId,
            cwd: modified.cwd,
            title: modified.title,
            updatedAt: modified.updatedAt,
          })
          .then(() => this._onDidChangeChatSessionItems.fire());

        this.logger.debug(
          `fired commit for session item change: ${original.acpSessionId} -> ${modified.acpSessionId}`,
        );
      }),
    );
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
  // end event definitions -----------------------------------------------------

  provideChatSessionItems(
    token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.ChatSessionItem[]> {
    return this.sessionManager.list();
  }
}
