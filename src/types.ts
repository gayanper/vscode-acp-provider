// SPDX-License-Identifier: Apache-2.0
export enum AgentType {
  OpenCode = "opencode",
  Codex = "codex",
  Cagent = "cagent",
  GeminiCLI = "geminicli",
}

export interface AcpStdioMcpServerConfiguration {
  readonly type: "stdio";
  readonly name: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Record<string, string>;
}

export type AcpMcpServerConfiguration = AcpStdioMcpServerConfiguration;

export interface AcpAgentConfigurationEntry {
  readonly label?: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly enabled?: boolean;
  readonly mcpServers?: readonly AcpMcpServerConfiguration[];
}

export const VscodeToolNames = {
  VscodeGetConfirmation: "vscode_get_confirmation",
  VscodeGetConfirmationWithOptions: "vscode_get_confirmation_with_options",
  TodoList: "manage_todo_list",
};

export const VscodeSessionOptions = {
  Mode: "mode",
  Model: "model",
  Agent: "agent",
};
