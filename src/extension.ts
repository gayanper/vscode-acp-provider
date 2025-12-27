/// <reference path="../vscode.proposed.chatSessionsProvider.d.ts" />
import * as vscode from "vscode";
import { AcpChatParticipant } from "./acpChatParticipant";
import { AcpChatSessionContentProvider } from "./acpChatSessionContentProvider";
import { AgentRegistry } from "./agentRegistry";
import { ACP_CHAT_SCHEME } from "./chatIdentifiers";
import {
  PermissionPromptManager,
  RESOLVE_PERMISSION_COMMAND,
} from "./permissionPrompts";

let resolvePermissionCommand: vscode.Disposable | undefined;
let contentProvider: AcpChatSessionContentProvider | undefined;

export async function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel("ACP Client");
  context.subscriptions.push(outputChannel);

  const permisionPromptsManager = new PermissionPromptManager();
  context.subscriptions.push(permisionPromptsManager);

  context.subscriptions.push(
    vscode.commands.registerCommand(RESOLVE_PERMISSION_COMMAND, (payload) => {
      permisionPromptsManager.resolveFromCommand(payload);
    }),
  );

  const restartCommand = vscode.commands.registerCommand(
    "vscodeAcpClient.restart",
    async () => {
      disposeAllSessions();
      vscode.window.showInformationMessage(
        "ACP chat sessions restarted. Open a session to reconnect.",
      );
    },
  );
  context.subscriptions.push(restartCommand);

  const agentRegistry = new AgentRegistry();
  registerAgents({
    registry: agentRegistry,
    permissionPromptManager: permisionPromptsManager,
    outputChannel,
    context,
  });
}

function registerAgents(params: {
  registry: AgentRegistry;
  permissionPromptManager: PermissionPromptManager;
  outputChannel: vscode.OutputChannel;
  context: vscode.ExtensionContext;
}): void {
  const { registry, permissionPromptManager, outputChannel, context } = params;
  registry.list().forEach((agent) => {
    const participant = new AcpChatParticipant(
      permissionPromptManager,
      outputChannel,
      `${ACP_CHAT_SCHEME}-${agent.id}`,
    );
    
    const sessionContentProvider = new AcpChatSessionContentProvider({
      agent,
      logChannel: outputChannel,
      participant,
    });

    context.subscriptions.push(
      vscode.chat.registerChatSessionContentProvider(
        `${ACP_CHAT_SCHEME}-${agent.id}`,
        sessionContentProvider,
        participant,
      ),
    );

    context.subscriptions.push(
      vscode.chat.registerChatSessionItemProvider(
        ACP_CHAT_SCHEME,
        sessionContentProvider,
      ),
    );
  });
}

export function deactivate(): void {
  disposeAllSessions();
}

function disposeAllSessions(): void {}
