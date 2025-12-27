import * as vscode from "vscode";
import { AcpClient } from "./acpClient";
import { AgentRegistryEntry } from "./agentRegistry";
import { DisposableBase } from "./disposables";

export interface SessionState extends vscode.Disposable {
  readonly agent: AgentRegistryEntry;
  readonly vscodeResource: vscode.Uri;
  readonly client: AcpClient;
  readonly acpSessionId: string;
  status: "idle" | "running" | "error";
  pendingRequest?: {
    cancellation: vscode.CancellationTokenSource;
    permissionContext?: vscode.Disposable;
  };
}

export function createSessionState(
  agent: AgentRegistryEntry,
  vscodeResource: vscode.Uri,
  client: AcpClient,
  acpSessionId: string,
): SessionState {
  return new SessionStateImpl(agent, vscodeResource, client, acpSessionId);
}

class SessionStateImpl extends DisposableBase implements SessionState {
  public status: SessionState["status"] = "idle";
  public pendingRequest: SessionState["pendingRequest"] | undefined;

  constructor(
    public readonly agent: AgentRegistryEntry,
    public readonly vscodeResource: vscode.Uri,
    public readonly client: AcpClient,
    public readonly acpSessionId: string,
  ) {
    super();
    this._register(this);
  }
}
