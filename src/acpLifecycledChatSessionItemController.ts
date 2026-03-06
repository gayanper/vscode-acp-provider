// SPDX-License-Identifier: Apache-2.0
import vscode, { ChatSessionStatus } from "vscode";
import { AcpSessionManager } from "./acpSessionManager";
import { DisposableBase } from "./disposables";
import { SessionDb } from "./acpSessionDb";
import { createSessionUri } from "./chatIdentifiers";

export function createAcpChatSessionItemController(
  chatSessionType: string,
  agentId: string,
  sessionManager: AcpSessionManager,
  sessionDb: SessionDb,
  logger: vscode.LogOutputChannel,
): vscode.Disposable {
  return new LifecycledChatSessionItemController(
    chatSessionType,
    agentId,
    sessionManager,
    sessionDb,
    logger,
  );
}

class LifecycledChatSessionItemController extends DisposableBase {
  private readonly controller: vscode.ChatSessionItemController;
  private readonly inProgressItems = new Map<string, vscode.ChatSessionItem>();

  constructor(
    chatSessionType: string,
    private readonly agentId: string,
    private readonly sessionManager: AcpSessionManager,
    private readonly sessionDb: SessionDb,
    private readonly logger: vscode.LogOutputChannel,
  ) {
    super();

    this.controller = this._register(
      vscode.chat.createChatSessionItemController(chatSessionType, (token) =>
        this.refresh(token),
      ),
    );

    this.controller.newChatSessionItemHandler = async (context, _token) => {
      const session = this.sessionManager.getActive(
        context.request.sessionResource,
      );
      if (session) {
        const uri = this.sessionManager.createSessionUri(session);
        const item = this.controller.createChatSessionItem(
          uri,
          session.acpSessionId,
        );
        item.status = ChatSessionStatus.InProgress;
        item.timing = { created: Date.now(), lastRequestStarted: Date.now() };
        this.inProgressItems.set(session.acpSessionId, item);
        this.logger.debug(
          `newChatSessionItemHandler: created item for session ${session.acpSessionId}`,
        );
        return item;
      }
      // Fallback: return a placeholder using the untitled resource.
      // Track it by resource URI so onDidChangeSession can update it once the
      // agent assigns a real session ID.
      const item = this.controller.createChatSessionItem(
        context.request.sessionResource,
        context.request.prompt,
      );
      item.status = ChatSessionStatus.InProgress;
      item.timing = { created: Date.now(), lastRequestStarted: Date.now() };
      this.inProgressItems.set(
        context.request.sessionResource.toString(),
        item,
      );
      this.logger.debug(
        `newChatSessionItemHandler: created fallback item for resource ${context.request.sessionResource}`,
      );
      return item;
    };

    this._register(
      this.sessionManager.onDidChangeSession(({ modified }) => {
        // Primary lookup by acpSessionId; fall back to resource URI for sessions
        // that were created via the fallback path in newChatSessionItemHandler
        // before the agent assigned a real session ID.
        const key = this.inProgressItems.has(modified.acpSessionId)
          ? modified.acpSessionId
          : modified.vscodeResource.toString();
        const inProgressItem = this.inProgressItems.get(key);
        if (inProgressItem) {
          // Mutate in-place — VS Code fires onDidChangeChatSessionItemState automatically
          inProgressItem.label = modified.title;
          inProgressItem.status = modified.status;
          const existing = inProgressItem.timing;
          if (modified.status === ChatSessionStatus.InProgress) {
            inProgressItem.timing = {
              ...(existing ?? { created: Date.now() }),
              lastRequestStarted: Date.now(),
              lastRequestEnded: undefined,
            };
          } else {
            inProgressItem.timing = {
              ...(existing ?? { created: Date.now() }),
              lastRequestEnded: Date.now(),
            };
          }

          if (
            modified.status !== ChatSessionStatus.InProgress &&
            modified.status !== ChatSessionStatus.NeedsInput
          ) {
            this.inProgressItems.delete(key);
            this.sessionDb
              .upsertSession(modified.agent.id, {
                sessionId: modified.acpSessionId,
                cwd: modified.cwd,
                title: modified.title,
                updatedAt: modified.updatedAt,
              })
              .then(() => {
                const cts = new vscode.CancellationTokenSource();
                return this.refresh(cts.token).finally(() => cts.dispose());
              })
              .catch((err) =>
                this.logger.error(
                  `Failed to persist session ${modified.acpSessionId}: ${err}`,
                ),
              );
            this.logger.debug(
              `session ${modified.acpSessionId} completed with status ${modified.status}`,
            );
          }
        }
      }),
    );
  }

  private async refresh(token: vscode.CancellationToken): Promise<void> {
    const diskItems = await this.sessionManager.list();
    const items = diskItems.map((i) => {
      const item = this.controller.createChatSessionItem(i.resource, i.label);
      item.status = i.status;
      if (i.timing) {
        item.timing = i.timing;
      }
      return item;
    });
    const merged = [...items, ...this.inProgressItems.values()];
    this.controller.items.replace(merged);
  }
}
