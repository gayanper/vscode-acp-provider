// SPDX-License-Identifier: Apache-2.0
import path from "path";
import * as vscode from "vscode";

export function getWorkspaceCwd(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return "";
  }
  return folders[0].uri.fsPath;
}

export function getWorkspaceRoots(): string[] {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return [];
  }
  return folders.map((folder) => folder.uri.fsPath);
}

export function coerceToFsPath(value: string): string {
  if (value.startsWith("file:")) {
    try {
      return vscode.Uri.parse(value).fsPath;
    } catch {
      return value;
    }
  }
  return value;
}

export function resolveWorkspacePath(targetPath: string): string | undefined {
  const normalized = coerceToFsPath(targetPath);
  const roots = getWorkspaceRoots();
  if (roots.length === 0) {
    return undefined;
  }
  const absolute = path.isAbsolute(normalized)
    ? normalized
    : path.join(roots[0], normalized);
  const resolved = path.resolve(absolute);
  const isAllowed = roots.some((root) => isWithin(root, resolved));
  if (!isAllowed) {
    return undefined;
  }
  return resolved;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!relative) {
    return true;
  }
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}
