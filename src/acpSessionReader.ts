import { SessionInfo } from "@agentclientprotocol/sdk";
import { spawn } from "child_process";
import { LogOutputChannel } from "vscode";
import { AgentRegistryEntry } from "./agentRegistry";
import { AgentType } from "./types";

export interface AcpSessionReader {
  listSessions(cwd: string): Promise<SessionInfo[]>;
}

const EmptySessionReader: AcpSessionReader = {
  async listSessions(): Promise<SessionInfo[]> {
    return [];
  },
};

export function createSessionReader(
  agent: AgentRegistryEntry,
  logger: LogOutputChannel,
): AcpSessionReader {
  switch (agent.id) {
    case AgentType.OpenCode:
      return new OpenCodeSessionReader(agent, logger);
    default:
      return EmptySessionReader;
  }
}

type OpenCodeOutputFormat = {
  id: string;
  title: string;
  updated: string;
  created: string;
  projectId: string;
  directory: string;
};

class OpenCodeSessionReader implements AcpSessionReader {
  constructor(
    private readonly agent: AgentRegistryEntry,
    private readonly logger: LogOutputChannel,
  ) {}

  async listSessions(cwd: string): Promise<SessionInfo[]> {
    try {
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(
          "opencode",
          ["session", "list", "--format", "json"],
          {
            cwd,
            env: {
              ...process.env,
              ...this.agent.env,
            },
          },
        );

        let stdout = "";
        let stderr = "";

        child.stdout?.on("data", (chunk) => {
          stdout += chunk.toString();
        });
        child.stderr?.on("data", (chunk) => {
          stderr += chunk.toString();
        });

        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) {
            resolve(stdout);
          } else {
            reject(
              new Error(`opencode exited with code ${code}: ${stderr.trim()}`),
            );
          }
        });
      });

      const data: OpenCodeOutputFormat[] = JSON.parse(
        output,
      ) as OpenCodeOutputFormat[];
      const sessions: SessionInfo[] = data.map(
        (item) =>
          ({
            id: item.id,
            cwd: item.directory,
            sessionId: item.id,
            title: item.title,
            updatedAt: item.updated,
          }) as SessionInfo,
      );

      return sessions;
    } catch (error) {
      this.logger.error(
        `[acp:${this.agent.id}] failed to list sessions: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return [];
    }
  }
}
