// SPDX-License-Identifier: Apache-2.0

/// <reference path="../vscode.proposed.chatProvider.d.ts" />
/// <reference path="../vscode.proposed.chatParticipantAdditions.d.ts" />
import * as vscode from "vscode";
import { DisposableBase } from "./disposables";

export const DEFAULT_MODEL_PROVIDER_ID = "acp-default";
const DEFAULT_MODEL_ID = DEFAULT_MODEL_PROVIDER_ID;
const DEFAULT_MODEL_FAMILY = "acp";
const ACP_DEFAULT_MAX_INPUT_TOKENS = 60_000;
const ACP_DEFAULT_MAX_OUTPUT_TOKENS = 8_000;

type DefaultModelInfo = vscode.LanguageModelChatInformation & {
  readonly isUserSelectable?: boolean;
};

const DEFAULT_MODEL: DefaultModelInfo = {
  id: DEFAULT_MODEL_ID,
  name: "ACP Default",
  family: DEFAULT_MODEL_FAMILY,
  version: "default",
  maxInputTokens: ACP_DEFAULT_MAX_INPUT_TOKENS,
  maxOutputTokens: ACP_DEFAULT_MAX_OUTPUT_TOKENS,
  capabilities: { toolCalling: true },
  isUserSelectable: true,
};

/**
 * A fallback language model provider that registers a dummy "acp-default" model.
 * This is used when GitHub Copilot is not installed or enabled, so that there is
 * always at least one model available in the model picker.
 */
export class DefaultLanguageModelProvider
  extends DisposableBase
  implements vscode.LanguageModelChatProvider<DefaultModelInfo>
{
  private readonly _onDidChangeLanguageModelChatInformation =
    new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation =
    this._onDidChangeLanguageModelChatInformation.event;

  constructor() {
    super();
    this._register(this._onDidChangeLanguageModelChatInformation);
  }

  provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<DefaultModelInfo[]> {
    return [DEFAULT_MODEL];
  }

  provideLanguageModelChatResponse(
    _model: DefaultModelInfo,
    _messages: readonly vscode.LanguageModelChatRequestMessage[],
    _options: vscode.ProvideLanguageModelChatResponseOptions,
    _progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    _token: vscode.CancellationToken,
  ): Thenable<void> {
    return Promise.resolve();
  }

  provideTokenCount(
    _model: DefaultModelInfo,
    _text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Thenable<number> {
    return Promise.resolve(0);
  }
}

/**
 * Returns true if GitHub Copilot (copilot or copilot-chat) is installed and active.
 */
export function isCopilotAvailable(): boolean {
  const copilot = vscode.extensions.getExtension("GitHub.copilot");
  const copilotChat = vscode.extensions.getExtension("GitHub.copilot-chat");
  return (
    (copilot !== undefined && copilot.isActive) ||
    (copilotChat !== undefined && copilotChat.isActive)
  );
}

export const DefaultParticipant: vscode.ChatExtendedRequestHandler = (
  request: vscode.ChatRequest,
  context: vscode.ChatContext,
  response: vscode.ChatResponseStream,
) => {
  response.markdown("Please use one of ACP Agents for your request");
};
