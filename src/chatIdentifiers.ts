import * as vscode from "vscode";

export const ACP_CHAT_SCHEME = "acp";

export function createChatSessionUri(agentId: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: ACP_CHAT_SCHEME,
    authority: agentId,
    path: "/session",
  });
}

export function getAgentIdFromResource(
  resource: vscode.Uri,
): string | undefined {
  if (!resource.scheme || !resource.scheme.startsWith(ACP_CHAT_SCHEME)) {
    return undefined;
  }
  return resource.scheme.substring(ACP_CHAT_SCHEME.length + 1);
}
