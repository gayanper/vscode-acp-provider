// SPDX-License-Identifier: Apache-2.0
import { RequestError } from "@agentclientprotocol/sdk";
import * as vscode from "vscode";

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

export const currentWorkspaceRoot = () =>
  vscode.workspace.workspaceFolders?.[0]?.uri;

export class ResolvableCallback {
  private r: ((value: unknown) => void) | undefined;

  callback(): Thenable<unknown> {
    return new Promise((r) => {
      this.r = r;
    });
  }

  resolve() {
    if (this.r) {
      this.r(undefined);
    }
  }
}

export const extractReadableErrorMessage = (error: unknown): string => {
  if (typeof error === "string") {
    return error;
  } else if (typeof error === "object") {
    if (error instanceof Error) {
      return error.message;
    } else if (error instanceof RequestError) {
      return extractReadableErrorMessage(error.cause);
    }
  }
  return JSON.stringify(error);
};
