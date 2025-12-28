import * as vscode from "vscode";
import { DisposableBase } from "./disposables";
import { AcpAgentConfigurationEntry, AgentType } from "./types";

export type AgentRegistryEntry = AcpAgentConfigurationEntry & {
  readonly id: AgentType;
  readonly label: string;
  readonly args: readonly string[];
  readonly enabled: boolean;
};

export class AgentRegistry extends DisposableBase {
  private readonly agents = new Map<string, AgentRegistryEntry>();
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();

  readonly onDidChange = this.onDidChangeEmitter.event;

  constructor() {
    super();
    this.reload();
    this._register(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("acpClient.agents")) {
          this.reload();
        }
      }),
    );
  }

  get(agentId: string): AgentRegistryEntry | undefined {
    return this.agents.get(agentId);
  }

  list(): readonly AgentRegistryEntry[] {
    return Array.from(this.agents.values());
  }

  private reload(): void {
    this.agents.clear();
    const configuration = vscode.workspace.getConfiguration("acpClient");
    const entries =
      configuration.get<Record<AgentType, AcpAgentConfigurationEntry>>(
        "agents",
      );

    for (const [agentId, entry] of Object.entries(entries || {})) {
      if (!entry.command) {
        continue;
      }
      if (entry.enabled === false) {
        continue;
      }

      const normalized: AgentRegistryEntry = {
        ...entry,
        id: agentId as AgentType,
        label: entry.label ?? agentId,
        args: entry.args ?? [],
        enabled: entry.enabled ?? true,
      };
      this.agents.set(agentId, normalized);
    }
    this.onDidChangeEmitter.fire();
  }
}
