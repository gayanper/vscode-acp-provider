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
  SessionInfo,
  SessionModelState,
  SessionModeState,
  SessionNotification,
  SetSessionModelRequest,
  SetSessionModeRequest,
  ToolCall,
} from "@agentclientprotocol/sdk";
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as vscode from "vscode";
import { AcpSessionReader, createSessionReader } from "./acpSessionReader";
import { AgentRegistryEntry } from "./agentRegistry";
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
  getCapabilities(): AgentCapabilities;
  createSession(cwd: string): Promise<NewSessionResponse>;
  getSupportedModelState(): SessionModelState | null;
  getSupportedModeState(): SessionModeState | null;
  loadSession(
    sessionId: string,
    cwd: string,
  ): Promise<{
    modeId: string | undefined;
    modelId: string | undefined;
    notifications: SessionNotification[];
  }>;
  prompt(sessionId: string, prompt: ContentBlock[]): Promise<PromptResponse>;
  cancel(sessionId: string): Promise<void>;
  changeMode(sessionId: string, modeId: string): Promise<void>;
  changeModel(sessionId: string, modelId: string): Promise<void>;
}

export function createAcpClient(
  agent: AgentRegistryEntry,
  permissionHandler: AcpPermissionHandler,
  logChannel: vscode.LogOutputChannel,
): AcpClient {
  return new AcpClientImpl(agent, permissionHandler, logChannel);
}

class AcpClientImpl extends DisposableBase implements AcpClient {
  private child?: ChildProcessWithoutNullStreams;
  private connection?: ClientSideConnection;
  private readyPromise?: Promise<void>;
  private agentCapabilities?: InitializeResponse;
  private supportedModelState: SessionModelState | null = null;
  private supportedModeState: SessionModeState | null = null;
  private readonly sessionReader: AcpSessionReader;

  private readonly onSessionUpdateEmitter = this._register(
    new vscode.EventEmitter<SessionNotification>(),
  );
  public readonly onSessionUpdate: vscode.Event<SessionNotification> =
    this.onSessionUpdateEmitter.event;
  private readonly onDidStopEmitter = this._register(
    new vscode.EventEmitter<void>(),
  );
  public readonly onDidStop: vscode.Event<void> = this.onDidStopEmitter.event;

  constructor(
    private readonly agent: AgentRegistryEntry,
    private readonly permissionHandler: AcpPermissionHandler,
    private readonly logChannel: vscode.LogOutputChannel,
  ) {
    super();
    this.sessionReader = createSessionReader(agent, logChannel);
  }

  async ensureReady(): Promise<void> {
    if (this.readyPromise) {
      return this.readyPromise;
    }
    this.readyPromise = this.createConnection();
    try {
      await this.readyPromise;
    } catch (error) {
      this.readyPromise = undefined;
      throw error;
    }
  }

  getCapabilities(): AgentCapabilities {
    return this.agentCapabilities || {};
  }

  async createSession(cwd: string): Promise<NewSessionResponse> {
    await this.ensureReady();
    if (!this.connection) {
      throw new Error("ACP connection is not ready");
    }
    const request: NewSessionRequest = {
      cwd,
      mcpServers: [],
    };
    const response: NewSessionResponse =
      await this.connection.newSession(request);
    this.supportedModeState = response.modes || null;
    this.supportedModelState = response.models || null;

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
  ): Promise<{
    modeId: string | undefined;
    modelId: string | undefined;
    notifications: SessionNotification[];
  }> {
    await this.ensureReady();
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
        mcpServers: [],
      });

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
    await this.ensureReady();
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
    await this.ensureReady();
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
    await this.ensureReady();
    if (!this.connection) {
      throw new Error("ACP connection is not ready");
    }

    const request: SetSessionModelRequest = {
      modelId,
      sessionId,
    };
    await this.connection.unstable_setSessionModel(request);
  }

  dispose(): void {
    this.stopProcess();
    super.dispose();
  }

  private async createConnection(): Promise<void> {
    this.stopProcess();
    const args = Array.from(this.agent.args ?? []);
    const child = spawn(this.agent.command, args, {
      cwd: this.agent.cwd ?? process.cwd(),
      env: {
        ...process.env,
        ...this.agent.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stderr?.on("data", (data) => {
      this.logChannel.appendLine(
        `[acp:${this.agent.id}] ${data.toString().trim()}`,
      );
    });
    child.on("exit", (code) => {
      this.logChannel.appendLine(
        `[acp:${this.agent.id}] exited with code ${code ?? "unknown"}`,
      );
      this.stopProcess();
      this.onDidStopEmitter.fire();
    });
    child.on("error", (error) => {
      this.logChannel.appendLine(
        `[acp:${this.agent.id}] failed to start: ${error instanceof Error ? error.message : String(error)}`,
      );
    });

    const stdinStream = child.stdin ? Writable.toWeb(child.stdin) : undefined;
    const stdoutStream = child.stdout
      ? Readable.toWeb(child.stdout)
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
  }

  private stopProcess(): void {
    if (this.child && !this.child.killed) {
      this.child.kill();
    }
    this.child = undefined;
    this.connection = undefined;
    this.readyPromise = undefined;
  }
}
