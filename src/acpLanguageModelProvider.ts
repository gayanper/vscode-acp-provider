// SPDX-License-Identifier: Apache-2.0

/// <reference path="../vscode.proposed.chatProvider.d.ts" />
import * as vscode from "vscode";
import { AgentRegistryEntry } from "./agentRegistry";
import { AcpSessionManager } from "./acpSessionManager";
import { DisposableBase } from "./disposables";

const SEED_MODEL_ID_SUFFIX = "-default";
const GLOBAL_STATE_KEY_PREFIX = "acp.models.";
const GLOBAL_STATE_MAX_TOKENS_KEY_PREFIX = "acp.modelMaxTokens.";
const ACP_DEFAULT_MAX_INPUT_TOKENS = 60_000;
const ACP_DEFAULT_MAX_OUTPUT_TOKENS = 8_000;

type AcpModelInfo = vscode.LanguageModelChatInformation & {
  readonly isUserSelectable?: boolean;
  readonly targetChatSessionType?: string;
};

export class AcpLanguageModelProvider
  extends DisposableBase
  implements vscode.LanguageModelChatProvider<AcpModelInfo>
{
  private readonly agentId: string;
  private readonly globalStateKey: string;
  private readonly maxTokensStateKey: string;
  private readonly seedModelId: string;
  private readonly sessionType: string;
  private models: AcpModelInfo[];
  private readonly modelMaxInputTokens: Map<string, number>;

  private readonly _onDidChangeLanguageModelChatInformation =
    new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation =
    this._onDidChangeLanguageModelChatInformation.event;

  constructor(
    private readonly agent: AgentRegistryEntry,
    sessionManager: AcpSessionManager,
    private readonly context: vscode.ExtensionContext,
  ) {
    super();
    this.agentId = agent.id;
    this.globalStateKey = `${GLOBAL_STATE_KEY_PREFIX}${this.agentId}`;
    this.maxTokensStateKey = `${GLOBAL_STATE_MAX_TOKENS_KEY_PREFIX}${this.agentId}`;
    this.seedModelId = `${this.agentId}${SEED_MODEL_ID_SUFFIX}`;
    this.sessionType = `acp-${this.agentId}`;

    // Load persisted max-token overrides from previous session
    const persistedMaxTokens = this.context.globalState.get<
      Record<string, number>
    >(this.maxTokensStateKey, {});
    this.modelMaxInputTokens = new Map(Object.entries(persistedMaxTokens));

    // Load persisted models from previous session
    const persisted = this.context.globalState.get<AcpModelInfo[]>(
      this.globalStateKey,
    );
    this.models = this.buildModelInfoList(persisted ?? []);

    this._register(
      sessionManager.onDidOptionsChange(async () => {
        const options = await sessionManager.getOptions();
        const modelState = options.models;
        if (!modelState) {
          return;
        }
        const realModels = modelState.availableModels.map((m) =>
          this.mapToModelInfo(m.modelId, m.name, m.description),
        );
        this.models = this.buildModelInfoList(realModels);
        await this.context.globalState.update(this.globalStateKey, realModels);
        this._onDidChangeLanguageModelChatInformation.fire();
      }),
    );

    this._register(
      sessionManager.onDidUsageUpdate(async ({ modelId, maxInputTokens }) => {
        this.modelMaxInputTokens.set(modelId, maxInputTokens);
        const persisted: Record<string, number> = {};
        this.modelMaxInputTokens.forEach((v, k) => {
          persisted[k] = v;
        });
        await this.context.globalState.update(
          this.maxTokensStateKey,
          persisted,
        );
        this.models = this.buildModelInfoList(
          this.models.filter((m) => m.id !== this.seedModelId),
        );
        this._onDidChangeLanguageModelChatInformation.fire();
      }),
    );

    this._register(this._onDidChangeLanguageModelChatInformation);
  }

  provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<AcpModelInfo[]> {
    return this.models;
  }

  provideLanguageModelChatResponse(
    model: AcpModelInfo,
    _messages: readonly vscode.LanguageModelChatRequestMessage[],
    _options: vscode.ProvideLanguageModelChatResponseOptions,
    _progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    _token: vscode.CancellationToken,
  ): Thenable<void> {
    // This provider acts purely as a proxy/registry. Actual request handling
    // is done by the ACP chat participant via provideLanguageModelChatResponse
    // being delegated to the participant's request handler.
    return Promise.resolve();
  }

  provideTokenCount(
    _model: AcpModelInfo,
    _text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Thenable<number> {
    return Promise.resolve(0);
  }

  private buildModelInfoList(realModels: AcpModelInfo[]): AcpModelInfo[] {
    const seed = this.buildSeedModel();
    // Deduplicate: don't include a real model entry if its id matches the seed
    const filtered = realModels.filter((m) => m.id !== this.seedModelId);
    return [seed, ...filtered];
  }

  private buildSeedModel(): AcpModelInfo {
    return {
      id: this.seedModelId,
      name: this.agent.label,
      family: `acp-${this.agentId}`,
      version: "default",
      maxInputTokens:
        this.modelMaxInputTokens.get(this.seedModelId) ??
        ACP_DEFAULT_MAX_INPUT_TOKENS,
      maxOutputTokens: ACP_DEFAULT_MAX_OUTPUT_TOKENS,
      capabilities: { toolCalling: true },
      isUserSelectable: false,
      targetChatSessionType: this.sessionType,
    };
  }

  private mapToModelInfo(
    modelId: string,
    name: string,
    description?: string | null,
  ): AcpModelInfo {
    return {
      id: modelId,
      name,
      family: `acp-${this.agentId}`,
      version: modelId,
      maxInputTokens:
        this.modelMaxInputTokens.get(modelId) ?? ACP_DEFAULT_MAX_INPUT_TOKENS,
      maxOutputTokens: ACP_DEFAULT_MAX_OUTPUT_TOKENS,
      capabilities: { toolCalling: true },
      tooltip: description ?? undefined,
      isUserSelectable: true,
      targetChatSessionType: this.sessionType,
    };
  }
}
