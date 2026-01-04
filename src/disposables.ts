// SPDX-License-Identifier: Apache-2.0
import * as vscode from "vscode";

export class DisposableBase implements vscode.Disposable {
  private readonly _disposables: vscode.Disposable[] = [];

  protected _register<T extends vscode.Disposable>(value: T): T {
    this._disposables.push(value);
    return value;
  }

  dispose(): void {
    while (this._disposables.length) {
      try {
        this._disposables.pop()?.dispose();
      } catch (error) {
        console.error("[acp] Failed to dispose resource", error);
      }
    }
  }
}
