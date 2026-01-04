// SPDX-License-Identifier: Apache-2.0
export enum AgentType {
  OpenCode = "opencode",
  Codex = "codex",
  Cagent = "cagent",
  GeminiCLI = "geminicli",
}

export interface AcpAgentConfigurationEntry {
  readonly label?: string;
  readonly description?: string;
  readonly icon?: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly enabled?: boolean;
}

export const VscodeToolNames = {
  VscodeGetConfirmation: "vscode_get_confirmation",
};

export const VscodeSessionOptions = {
  Mode: "mode",
  Model: "model",
  Agent: "agent",
};
