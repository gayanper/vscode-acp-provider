/// <reference path="../vscode.proposed.chatSessionsProvider.d.ts" />
import * as vscode from "vscode";
import { AcpChatParticipant } from "./acpChatParticipant";
import { AcpChatSessionContentProvider } from "./acpChatSessionContentProvider";
import { createAcpSessionManager } from "./acpSessionManager";
import { AgentRegistry } from "./agentRegistry";
import { ACP_CHAT_SCHEME } from "./chatIdentifiers";
import {
  createPermissionResolveCommandId,
  PermissionPromptManager,
} from "./permissionPrompts";
import { createAcpChatSessionItemProvider } from "./acpChatSessionItemProvider";

export async function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel("ACP Client", {
    log: true,
  });
  context.subscriptions.push(outputChannel);

  const agentRegistry = new AgentRegistry();
  registerAgents({
    registry: agentRegistry,
    outputChannel,
    context,
  });
}

function registerAgents(params: {
  registry: AgentRegistry;
  outputChannel: vscode.LogOutputChannel;
  context: vscode.ExtensionContext;
}): void {
  const { registry, outputChannel, context } = params;
  registry.list().forEach((agent) => {
    const permisionPromptsManager = new PermissionPromptManager();
    context.subscriptions.push(permisionPromptsManager);

    context.subscriptions.push(
      vscode.commands.registerCommand(
        createPermissionResolveCommandId(agent.id),
        (payload) => {
          permisionPromptsManager.resolveFromCommand(payload);
        },
      ),
    );

    const participant = new AcpChatParticipant(
      permisionPromptsManager,
      outputChannel,
      `${ACP_CHAT_SCHEME}-${agent.id}`,
    );
    context.subscriptions.push(participant);

    const sessionManager = createAcpSessionManager(
      agent,
      permisionPromptsManager,
      outputChannel,
    );
    context.subscriptions.push(sessionManager);

    const sessionContentProvider = new AcpChatSessionContentProvider(
      sessionManager,
      participant,
      outputChannel,
    );
    context.subscriptions.push(sessionContentProvider);

    const participantInstance = vscode.chat.createChatParticipant(
      `${ACP_CHAT_SCHEME}-${agent.id}`,
      participant.createHandler(),
    );
    context.subscriptions.push(
      vscode.chat.registerChatSessionContentProvider(
        `${ACP_CHAT_SCHEME}-${agent.id}`,
        sessionContentProvider,
        participantInstance,
      ),
    );

    const sessionItemProvider = createAcpChatSessionItemProvider(
      sessionManager,
      outputChannel,
    );
    context.subscriptions.push(sessionItemProvider);
    context.subscriptions.push(
      vscode.chat.registerChatSessionItemProvider(
        `${ACP_CHAT_SCHEME}-${agent.id}`,
        sessionItemProvider,
      ),
    );
  });
}

export function deactivate(): void {}
