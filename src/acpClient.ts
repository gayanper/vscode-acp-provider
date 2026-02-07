// SPDX-License-Identifier: Apache-2.0
import {
  AgentCapabilities,
  Client,
  ClientCapabilities,
  ClientSideConnection,
  ContentBlock,
  InitializeResponse,
  LoadSessionResponse,
  ndJsonStream,
  NewSessionRequest,
  NewSessionResponse,
  PromptResponse,
  PROTOCOL_VERSION,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionModelState,
  SessionModeState,
  McpServer,
  McpServerStdio,
  SessionNotification,
  SetSessionModelRequest,
  SetSessionModeRequest,
} from "@agentclientprotocol/sdk";
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as vscode from "vscode";
import { AgentRegistryEntry } from "./agentRegistry";
import type { AcpMcpServerConfiguration } from "./types";
import { DisposableBase } from "./disposables";

export interface AcpPermissionHandler {
  requestPermission(
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse>;
}

const CLIENT_CAPABILITIES: ClientCapabilities = {
  fs: {
    readTextFile: true,
    writeTextFile: true,
  },
  terminal: true,
};

const CLIENT_INFO = {
  name: "github-copilot-acp-client",
  version: "1.0.0",
};

export interface AcpClient extends Client, vscode.Disposable {
  onSessionUpdate: vscode.Event<SessionNotification>;
  onDidStop: vscode.Event<void>;
  onDidStart: vscode.Event<void>;
  onDidOptionsChanged: vscode.Event<void>;

  getCapabilities(): AgentCapabilities;
  createSession(
    cwd: string,
    mcpServers: AgentRegistryEntry["mcpServers"],
  ): Promise<NewSessionResponse>;
  getSupportedModelState(): SessionModelState | null;
  getSupportedModeState(): SessionModeState | null;
  loadSession(
    sessionId: string,
    cwd: string,
    mcpServers: AgentRegistryEntry["mcpServers"],
  ): Promise<{
    modeId: string | undefined;
    modelId: string | undefined;
    notifications: SessionNotification[];
  }>;
  prompt(sessionId: string, prompt: ContentBlock[]): Promise<PromptResponse>;
  cancel(sessionId: string): Promise<void>;
  changeMode(sessionId: string, modeId: string): Promise<void>;
  changeModel(sessionId: string, modelId: string): Promise<void>;
  sendQuestionAnswers(
    sessionId: string,
    toolCallId: string,
    answers: Record<string, unknown>,
  ): Promise<void>;
}

export function createAcpClient(
  agent: AgentRegistryEntry,
  permissionHandler: AcpPermissionHandler,
  logChannel: vscode.LogOutputChannel,
): AcpClient {
  return new AcpClientImpl(agent, permissionHandler, logChannel);
}

type ClientMode = "new_session" | "load_session";

class AcpClientImpl extends DisposableBase implements AcpClient {
  private agentProcess: ChildProcessWithoutNullStreams | null = null;
  private connection: ClientSideConnection | null = null;
  private readyPromise: Promise<void> | null = null;
  private agentCapabilities?: InitializeResponse;
  private supportedModelState: SessionModelState | null = null;
  private supportedModeState: SessionModeState | null = null;

  private readonly onSessionUpdateEmitter = this._register(
    new vscode.EventEmitter<SessionNotification>(),
  );
  public readonly onSessionUpdate: vscode.Event<SessionNotification> =
    this.onSessionUpdateEmitter.event;

  private readonly _onDidStop = this._register(new vscode.EventEmitter<void>());
  public readonly onDidStop: vscode.Event<void> = this._onDidStop.event;

  private readonly _onDidStart = this._register(
    new vscode.EventEmitter<void>(),
  );
  public readonly onDidStart: vscode.Event<void> = this._onDidStart.event;

  private readonly _onDidOptionsChanged = this._register(
    new vscode.EventEmitter<void>(),
  );
  public readonly onDidOptionsChanged: vscode.Event<void> =
    this._onDidOptionsChanged.event;

  private mode: ClientMode = "new_session";

  constructor(
    private readonly agent: AgentRegistryEntry,
    private readonly permissionHandler: AcpPermissionHandler,
    private readonly logChannel: vscode.LogOutputChannel,
  ) {
    super();
  }

  async ensureReady(expectedMode: ClientMode): Promise<void> {
    if (this.readyPromise) {
      if (this.mode === expectedMode) {
        return this.readyPromise;
      }
    }

    await this.stopProcess();
    this.readyPromise = this.createConnection(expectedMode);
    try {
      await this.readyPromise;
    } catch (error) {
      this.readyPromise = null;
      throw error;
    }
  }

  getCapabilities(): AgentCapabilities {
    return this.agentCapabilities || {};
  }

  async createSession(
    cwd: string,
    mcpServers: AgentRegistryEntry["mcpServers"],
  ): Promise<NewSessionResponse> {
    await this.ensureReady("new_session");

    if (!this.connection) {
      throw new Error("ACP connection is not ready");
    }
    const request: NewSessionRequest = {
      cwd,
      mcpServers: serializeMcpServers(mcpServers),
    };
    const response: NewSessionResponse =
      await this.connection.newSession(request);
    this.supportedModeState = response.modes || null;
    this.supportedModelState = response.models || null;

    this._onDidOptionsChanged.fire();

    return response;
  }

  getSupportedModelState(): SessionModelState | null {
    return this.supportedModelState;
  }

  getSupportedModeState(): SessionModeState | null {
    return this.supportedModeState;
  }

  async loadSession(
    sessionId: string,
    cwd: string,
    mcpServers: AgentRegistryEntry["mcpServers"],
  ): Promise<{
    modeId: string | undefined;
    modelId: string | undefined;
    notifications: SessionNotification[];
  }> {
    await this.ensureReady("load_session");
    if (!this.connection) {
      throw new Error("ACP connection is not ready");
    }

    const notifications: SessionNotification[] = [];

    const subscription = this.onSessionUpdate((notification) => {
      if (notification.sessionId === sessionId) {
        // Capture all session update types for history reconstruction
        notifications.push(notification);
      }
    });

    try {
      const response: LoadSessionResponse = await this.connection.loadSession({
        sessionId,
        cwd,
        mcpServers: serializeMcpServers(mcpServers),
      });

      this.supportedModelState = response.models || null;
      this.supportedModeState = response.modes || null;
      this._onDidOptionsChanged.fire();

      return {
        modelId: response.models?.currentModelId,
        modeId: response.modes?.currentModeId,
        notifications: notifications,
      };
    } finally {
      subscription.dispose();
    }
  }

  async prompt(
    sessionId: string,
    prompt: ContentBlock[],
  ): Promise<PromptResponse> {
    await this.ensureReady(this.mode);
    if (!this.connection) {
      throw new Error("ACP connection is not ready");
    }
    return this.connection.prompt({
      sessionId,
      prompt,
    });
  }

  async cancel(sessionId: string): Promise<void> {
    if (!this.connection) {
      return;
    }
    try {
      await this.connection.cancel({
        sessionId,
        requestId: "",
      });
    } catch (error) {
      this.logChannel.appendLine(
        `[acp:${this.agent.id}] failed to cancel session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  requestPermission(
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    return this.permissionHandler.requestPermission(request);
  }

  async sessionUpdate(notification: SessionNotification): Promise<void> {
    this.onSessionUpdateEmitter.fire(notification);
  }

  async changeMode(sessionId: string, modeId: string): Promise<void> {
    await this.ensureReady(this.mode);
    if (!this.connection) {
      throw new Error("ACP connection is not ready");
    }
    const resuest: SetSessionModeRequest = {
      modeId,
      sessionId,
    };
    await this.connection.setSessionMode(resuest);
  }

  async changeModel(sessionId: string, modelId: string): Promise<void> {
    await this.ensureReady(this.mode);
    if (!this.connection) {
      throw new Error("ACP connection is not ready");
    }

    const request: SetSessionModelRequest = {
      modelId,
      sessionId,
    };
    await this.connection.unstable_setSessionModel(request);
  }

  async sendQuestionAnswers(
    sessionId: string,
    toolCallId: string,
    answers: Record<string, unknown>,
  ): Promise<void> {
    if (!this.connection) {
      this.logChannel.warn(
        "Cannot send question answers: connection not ready",
      );
      return;
    }

    try {
      await this.connection.extNotification("questionAnswers", {
        sessionId,
        toolCallId,
        answers,
      });
    } catch (error) {
      this.logChannel.error(
        `Failed to send question answers: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async dispose(): Promise<void> {
    await this.stopProcess();
    super.dispose();
  }

  private async ensureAgentRunning(): Promise<void> {
    if (this.agentProcess && !this.agentProcess.killed) {
      return;
    }
    const args = Array.from(this.agent.args ?? []);
    const agentProc = spawn(this.agent.command, args, {
      cwd: this.agent.cwd ?? process.cwd(),
      env: {
        ...process.env,
        ...this.agent.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    agentProc.stderr?.on("data", (data) => {
      this.logChannel.debug(`agent:${this.agent.id} ${data.toString().trim()}`);
    });
    agentProc.on("exit", async (code) => {
      this.logChannel.debug(
        `agent:${this.agent.id} exited with code ${code ?? "unknown"}`,
      );
      this._onDidStop.fire();
    });
    agentProc.on("error", (error) => {
      this.logChannel.debug(
        `agent:${this.agent.id} failed to start: ${error instanceof Error ? error.message : String(error)}`,
      );
      // todo: emit agent proc error upstream
    });
    this.agentProcess = agentProc;
  }

  private async createConnection(mode: ClientMode): Promise<void> {
    await this.ensureAgentRunning();
    const stdinStream = this.agentProcess?.stdin
      ? Writable.toWeb(this.agentProcess.stdin)
      : undefined;
    const stdoutStream = this.agentProcess?.stdout
      ? Readable.toWeb(this.agentProcess.stdout)
      : undefined;
    if (!stdinStream || !stdoutStream) {
      throw new Error("Failed to connect ACP client streams");
    }
    const stream = ndJsonStream(stdinStream, stdoutStream);
    this.connection = new ClientSideConnection(() => this, stream);

    const initResponse = await this.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: CLIENT_CAPABILITIES,
      clientInfo: CLIENT_INFO,
    });
    this.agentCapabilities = initResponse.agentCapabilities;
    this._onDidStart.fire();
    this.mode = mode;
  }

  private async stopProcess(): Promise<void> {
    if (this.agentProcess && !this.agentProcess.killed) {
      this.agentProcess.kill();
      await this.connection?.closed;
    }

    this.agentProcess = null;
    this.connection = null;
    this.readyPromise = null;
  }
}

function serializeMcpServers(
  mcpServers: readonly AcpMcpServerConfiguration[] | undefined,
): McpServer[] {
  if (!mcpServers?.length) {
    return [];
  }
  return mcpServers
    .map(serializeStdioServer)
    .filter((value): value is McpServerStdio => value !== null);
}

function serializeStdioServer(
  config: AcpMcpServerConfiguration,
): McpServerStdio | null {
  if (config.type !== "stdio") {
    return null;
  }

  return {
    name: config.name,
    command: config.command,
    args: Array.from(config.args ?? []),
    env: serializeEnv(config.env),
  } satisfies McpServerStdio;
}

function serializeEnv(
  env: Record<string, string> | undefined,
): McpServerStdio["env"] {
  if (!env) {
    return [];
  }
  return Object.entries(env).map(([name, value]) => ({ name, value }));
}
