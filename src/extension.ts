// SPDX-License-Identifier: Apache-2.0
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
import { createSessionStore, SessionStore } from "./acpSessionStore";
import { createTestAcpClientWithScenarios } from "./testScenarios";
import { AcpClient } from "./acpClient";
import { registerCommands } from "./commands";

export async function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel("ACP Client", {
    log: true,
  });
  context.subscriptions.push(outputChannel);

  const sessionStore = createSessionStore(context, outputChannel);
  context.subscriptions.push(sessionStore);

  const agentRegistry = new AgentRegistry();
  registerAgents({
    registry: agentRegistry,
    sessionStore,
    outputChannel,
    context,
  });

  registerCommands(context, { sessionStore }, outputChannel);
}

function registerAgents(params: {
  registry: AgentRegistry;
  sessionStore: SessionStore;
  outputChannel: vscode.LogOutputChannel;
  context: vscode.ExtensionContext;
}): void {
  const { registry, outputChannel, context } = params;
  registry.list().forEach((agent) => {
    const permisionPromptsManager = new PermissionPromptManager(outputChannel);
    context.subscriptions.push(permisionPromptsManager);

    context.subscriptions.push(
      vscode.commands.registerCommand(
        createPermissionResolveCommandId(agent.id),
        (payload) => {
          permisionPromptsManager.resolveFromCommand(payload);
        },
      ),
    );
    type P = () => AcpClient;
    let clientProvider: P | undefined = undefined;
    if (process.env.MOCK_CLIENT === "true") {
      clientProvider = () => {
        return createTestAcpClientWithScenarios(permisionPromptsManager);
      };
    }

    const sessionManager = createAcpSessionManager(
      params.sessionStore,
      agent,
      permisionPromptsManager,
      outputChannel,
      clientProvider,
    );
    context.subscriptions.push(sessionManager);

    const participant = new AcpChatParticipant(
      permisionPromptsManager,
      sessionManager,
      outputChannel,
      `${ACP_CHAT_SCHEME}-${agent.id}`,
    );
    context.subscriptions.push(participant);

    const sessionContentProvider = new AcpChatSessionContentProvider(
      sessionManager,
      participant,
      outputChannel,
    );
    context.subscriptions.push(sessionContentProvider);

    const participantInstance = vscode.chat.createChatParticipant(
      `${ACP_CHAT_SCHEME}-${agent.id}`,
      participant.requestHandler,
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
      params.sessionStore,
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

export function deactivate(): void { }
