// SPDX-License-Identifier: Apache-2.0
import * as vscode from "vscode";

export const ACP_CHAT_SCHEME = "acp";

export function getAgentIdFromResource(
  resource: vscode.Uri,
): string | undefined {
  if (!resource.scheme || !resource.scheme.startsWith(ACP_CHAT_SCHEME)) {
    return undefined;
  }
  return resource.scheme.substring(ACP_CHAT_SCHEME.length + 1);
}

export function createSessionType(agentId: string): string {
  return `${ACP_CHAT_SCHEME}-${agentId}`;
}

export function createSessionUri(agentId: string, sessionId: string) {
  return vscode.Uri.parse(`${createSessionType(agentId)}:/${sessionId}`);
}

export function decodeVscodeResource(resource: vscode.Uri): {
  isUntitled: boolean;
  sessionId: string;
} {
  if (!resource.path || resource.path.length < 2) {
    throw new Error(`Invalid resource path: ${resource.toString()}`);
  }

  let sessionId: string = resource.path.substring(1);
  const isUntitled = sessionId.startsWith("untitled-");

  return {
    isUntitled,
    sessionId,
  };
}
