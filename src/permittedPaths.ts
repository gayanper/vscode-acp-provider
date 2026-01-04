// SPDX-License-Identifier: Apache-2.0
import * as vscode from "vscode";

export function getWorkspaceCwd(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return vscode.env.appRoot;
  }
  return folders[0].uri.fsPath;
}
