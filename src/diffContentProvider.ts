// SPDX-License-Identifier: Apache-2.0
import * as vscode from "vscode";
import { DisposableBase } from "./disposables";

export const ACP_DIFF_SCHEME = "acp-diff";

type DiffUriOptions = {
  side: "original" | "modified";
  toolCallId: string;
  fileUri: vscode.Uri;
  index: number;
};

class DiffContentProvider
  extends DisposableBase
  implements vscode.TextDocumentContentProvider
{
  private readonly contents = new Map<string, string>();
  private readonly _onDidChange = this._register(
    new vscode.EventEmitter<vscode.Uri>(),
  );
  readonly onDidChange = this._onDidChange.event;

  provideTextDocumentContent(uri: vscode.Uri): string | undefined {
    return this.contents.get(uri.toString());
  }

  setContent(uri: vscode.Uri, content: string): void {
    this.contents.set(uri.toString(), content);
    this._onDidChange.fire(uri);
  }
}

let diffProvider: DiffContentProvider | undefined;
let diffProviderRegistered = false;

export function registerDiffContentProvider(
  context: vscode.ExtensionContext,
): DiffContentProvider {
  if (!diffProvider) {
    diffProvider = new DiffContentProvider();
  }
  if (!diffProviderRegistered) {
    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(
        ACP_DIFF_SCHEME,
        diffProvider,
      ),
    );
    diffProviderRegistered = true;
  }
  context.subscriptions.push(diffProvider);
  return diffProvider;
}

export function createDiffUri({
  side,
  toolCallId,
  fileUri,
  index,
}: DiffUriOptions): vscode.Uri {
  return fileUri.with({
    scheme: ACP_DIFF_SCHEME,
    query: `side=${side}&toolCallId=${encodeURIComponent(toolCallId)}&index=${index}`,
  });
}

export function setDiffContent(uri: vscode.Uri, content: string): void {
  diffProvider?.setContent(uri, content);
}
