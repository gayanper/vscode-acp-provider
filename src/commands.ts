import * as vscode from "vscode";
import { SessionDb } from "./acpSessionDb";
import { getWorkspaceCwd } from "./permittedPaths";

export function registerCommands(
  context: vscode.ExtensionContext,
  dependencies: {
    sessionDb: SessionDb;
  },
  outputChannel: vscode.LogOutputChannel,
) {
  context.subscriptions.push(
    vscode.commands.registerCommand("acp.clearSessions", async () => {
      try {
        await dependencies.sessionDb.deleteAllSessions(getWorkspaceCwd());
        vscode.window.showInformationMessage(
          "All ACP sessions have been cleared.",
        );
      } catch (error) {
        outputChannel.error(`Error clearing sessions: ${error}`);
        vscode.window.showErrorMessage(
          "Failed to clear ACP sessions. Check output for details.",
        );
      }
    }),

    vscode.commands.registerCommand(
      "acp.insertChatText",
      async (text: string) => {
        await vscode.commands.executeCommand("workbench.action.chat.open", {
          query: text,
          isPartialQuery: true,
        });
      },
    ),
  );
}
