// SPDX-License-Identifier: Apache-2.0
import {
  AgentCapabilities,
  Client,
  ClientCapabilities,
  ClientSideConnection,
  ContentBlock,
  CreateTerminalRequest,
  CreateTerminalResponse,
  InitializeResponse,
  KillTerminalCommandRequest,
  KillTerminalCommandResponse,
  LoadSessionResponse,
  ndJsonStream,
  NewSessionRequest,
  NewSessionResponse,
  PromptResponse,
  PROTOCOL_VERSION,
  ReadTextFileRequest,
  ReadTextFileResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  RequestError,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionModelState,
  SessionModeState,
  McpServer,
  McpServerStdio,
  SessionNotification,
  SetSessionModelRequest,
  SetSessionModeRequest,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import {
  ChildProcess,
  ChildProcessWithoutNullStreams,
  spawn,
} from "node:child_process";
import path from "path";
import { TextDecoder, TextEncoder } from "node:util";
import { Readable, Writable } from "node:stream";
import * as vscode from "vscode";
import { AgentRegistryEntry } from "./agentRegistry";
import type { AcpMcpServerConfiguration } from "./types";
import { DisposableBase } from "./disposables";
import { getWorkspaceCwd, resolveWorkspacePath } from "./permittedPaths";

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

const DEFAULT_TERMINAL_OUTPUT_LIMIT = 200_000;

type TerminalState = {
  id: string;
  sessionId: string;
  process: ChildProcess;
  output: string;
  truncated: boolean;
  outputByteLimit: number | null;
  exitStatus: { exitCode?: number | null; signal?: string | null } | null;
  exitPromise: Promise<{ exitCode?: number | null; signal?: string | null }>;
  resolveExit: (status: {
    exitCode?: number | null;
    signal?: string | null;
  }) => void;
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
}

export function createAcpClient(
  agent: AgentRegistryEntry,
  permissionHandler: AcpPermissionHandler,
  logChannel: vscode.LogOutputChannel,
): AcpClient {
  return new AcpClientImpl(agent, permissionHandler, logChannel);
}

class AcpClientImpl extends DisposableBase implements AcpClient {
  private agentProcess: ChildProcessWithoutNullStreams | null = null;
  private connection: ClientSideConnection | null = null;
  private readyPromise: Promise<void> | null = null;
  private agentCapabilities?: InitializeResponse;
  private supportedModelState: SessionModelState | null = null;
  private supportedModeState: SessionModeState | null = null;
  private terminalIdCounter = 0;
  private terminals = new Map<string, TerminalState>();
  private readonly textEncoder = new TextEncoder();
  private readonly textDecoder = new TextDecoder("utf-8");
  private readonly allowedWriteSessions = new Set<string>();
  private readonly allowedTerminalSessions = new Set<string>();
  private permissionPromptCounter = 0;

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

  constructor(
    private readonly agent: AgentRegistryEntry,
    private readonly permissionHandler: AcpPermissionHandler,
    private readonly logChannel: vscode.LogOutputChannel,
  ) {
    super();
  }

  async ensureReady(): Promise<void> {
    if (this.readyPromise) {
      return this.readyPromise;
    }

    this.readyPromise = this.createConnection();
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
    await this.ensureReady();

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

  async readTextFile(
    params: ReadTextFileRequest,
  ): Promise<ReadTextFileResponse> {
    this.ensureWorkspaceOpen();
    const resolvedPath = this.resolveWorkspacePathOrThrow(params.path);
    try {
      const data = await vscode.workspace.fs.readFile(
        vscode.Uri.file(resolvedPath),
      );
      const text = this.textDecoder.decode(data);
      const lines = text.split(/\r?\n/);
      const start = Math.max(0, (params.line ?? 1) - 1);
      const limit = params.limit ?? undefined;
      const end = limit && limit > 0 ? start + limit : lines.length;
      const content = lines.slice(start, end).join("\n");
      return { content };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw RequestError.resourceNotFound(resolvedPath);
      }
      throw RequestError.internalError(error);
    }
  }

  async writeTextFile(
    params: WriteTextFileRequest,
  ): Promise<WriteTextFileResponse> {
    this.ensureWorkspaceOpen();
    this.ensureWorkspaceTrusted();
    await this.ensureToolPermission(
      params.sessionId,
      "write",
      `Allow agent to write ${params.path}?`,
      { path: params.path, bytes: params.content?.length ?? 0 },
    );
    const resolvedPath = this.resolveWorkspacePathOrThrow(params.path);
    try {
      const dir = path.dirname(resolvedPath);
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir));
      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(resolvedPath),
        this.textEncoder.encode(params.content ?? ""),
      );
      return {};
    } catch (error) {
      throw RequestError.internalError(error);
    }
  }

  async createTerminal(
    params: CreateTerminalRequest,
  ): Promise<CreateTerminalResponse> {
    this.ensureWorkspaceOpen();
    this.ensureWorkspaceTrusted();
    await this.ensureToolPermission(
      params.sessionId,
      "terminal",
      `Allow agent to run ${params.command}?`,
      { command: params.command, args: params.args ?? [], cwd: params.cwd },
    );
    const cwd = params.cwd
      ? this.resolveWorkspacePathOrThrow(params.cwd)
      : getWorkspaceCwd();
    const args = params.args ?? [];
    const env = this.mergeTerminalEnv(params.env);

    const terminalId = this.createTerminalId();
    const proc = spawn(params.command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const outputLimit = params.outputByteLimit ?? DEFAULT_TERMINAL_OUTPUT_LIMIT;
    const state = this.createTerminalState(
      terminalId,
      params.sessionId,
      proc,
      outputLimit,
    );
    this.terminals.set(terminalId, state);

    proc.stdout?.on("data", (data) => this.appendTerminalOutput(state, data));
    proc.stderr?.on("data", (data) => this.appendTerminalOutput(state, data));
    proc.on("exit", (code, signal) => {
      state.exitStatus = {
        exitCode: code === null ? null : code,
        signal: signal === null ? null : signal,
      };
      state.resolveExit(state.exitStatus);
    });
    proc.on("error", (error) => {
      this.logChannel.debug(
        `terminal:${terminalId} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (!state.exitStatus) {
        state.exitStatus = { exitCode: null, signal: "error" };
        state.resolveExit(state.exitStatus);
      }
    });

    return { terminalId };
  }

  async terminalOutput(
    params: TerminalOutputRequest,
  ): Promise<TerminalOutputResponse> {
    const state = this.getTerminalState(params.terminalId, params.sessionId);
    return {
      output: state.output,
      truncated: state.truncated,
      exitStatus: state.exitStatus ?? null,
    };
  }

  async waitForTerminalExit(
    params: WaitForTerminalExitRequest,
  ): Promise<WaitForTerminalExitResponse> {
    const state = this.getTerminalState(params.terminalId, params.sessionId);
    const status = state.exitStatus ?? (await state.exitPromise);
    return {
      exitCode: status.exitCode ?? null,
      signal: status.signal ?? null,
    };
  }

  async killTerminal(
    params: KillTerminalCommandRequest,
  ): Promise<KillTerminalCommandResponse> {
    const state = this.getTerminalState(params.terminalId, params.sessionId);
    if (!state.exitStatus && !state.process.killed) {
      state.process.kill();
    }
    return {};
  }

  async releaseTerminal(
    params: ReleaseTerminalRequest,
  ): Promise<ReleaseTerminalResponse> {
    const state = this.getTerminalState(params.terminalId, params.sessionId);
    if (!state.exitStatus && !state.process.killed) {
      state.process.kill();
    }
    this.terminals.delete(state.id);
    return {};
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

  async dispose(): Promise<void> {
    await this.stopProcess();
    super.dispose();
  }

  private resolveWorkspacePathOrThrow(requestPath: string): string {
    const resolved = resolveWorkspacePath(requestPath);
    if (!resolved) {
      if (!vscode.workspace.workspaceFolders?.length) {
        throw RequestError.invalidParams(undefined, "No workspace is open.");
      }
      throw RequestError.invalidParams(
        undefined,
        `Path is outside the workspace: ${requestPath}`,
      );
    }
    return resolved;
  }

  private ensureWorkspaceOpen(): void {
    if (!vscode.workspace.workspaceFolders?.length) {
      throw RequestError.invalidParams(undefined, "No workspace is open.");
    }
  }

  private ensureWorkspaceTrusted(): void {
    if (!vscode.workspace.isTrusted) {
      throw RequestError.invalidParams(
        undefined,
        "Workspace is not trusted for file or terminal operations.",
      );
    }
  }

  private async ensureToolPermission(
    sessionId: string,
    kind: "write" | "terminal",
    title: string,
    rawInput: unknown,
  ): Promise<void> {
    const allowedSet =
      kind === "write"
        ? this.allowedWriteSessions
        : this.allowedTerminalSessions;
    if (allowedSet.has(sessionId)) {
      return;
    }

    this.permissionPromptCounter += 1;
    const response = await this.permissionHandler.requestPermission({
      sessionId,
      toolCall: {
        toolCallId: `acp-${kind}-${Date.now()}-${this.permissionPromptCounter}`,
        title,
        rawInput,
      },
      options: [
        {
          kind: "allow_once",
          name: "Allow once",
          optionId: "allow_once",
        },
        {
          kind: "allow_always",
          name: "Allow always",
          optionId: "allow_always",
        },
        {
          kind: "reject_once",
          name: "Deny",
          optionId: "deny",
        },
      ],
    });

    if (response.outcome.outcome !== "selected") {
      throw RequestError.invalidParams(undefined, "Permission denied.");
    }

    if (response.outcome.optionId === "allow_always") {
      allowedSet.add(sessionId);
      return;
    }

    if (response.outcome.optionId === "allow_once") {
      return;
    }

    throw RequestError.invalidParams(undefined, "Permission denied.");
  }

  private createTerminalId(): string {
    this.terminalIdCounter += 1;
    return `acp-terminal-${Date.now()}-${this.terminalIdCounter}`;
  }

  private createTerminalState(
    id: string,
    sessionId: string,
    proc: ChildProcess,
    outputByteLimit: number | null,
  ): TerminalState {
    let resolveExit: (status: {
      exitCode?: number | null;
      signal?: string | null;
    }) => void;
    const exitPromise = new Promise<{
      exitCode?: number | null;
      signal?: string | null;
    }>((resolve) => {
      resolveExit = resolve;
    });

    return {
      id,
      sessionId,
      process: proc,
      output: "",
      truncated: false,
      outputByteLimit: outputByteLimit ?? null,
      exitStatus: null,
      exitPromise,
      resolveExit: resolveExit!,
    };
  }

  private getTerminalState(
    terminalId: string,
    sessionId: string,
  ): TerminalState {
    const state = this.terminals.get(terminalId);
    if (!state) {
      throw RequestError.resourceNotFound(terminalId);
    }
    if (state.sessionId !== sessionId) {
      throw RequestError.invalidParams(
        undefined,
        `Terminal ${terminalId} does not belong to session ${sessionId}`,
      );
    }
    return state;
  }

  private appendTerminalOutput(state: TerminalState, data: Buffer): void {
    const chunk = data.toString("utf8");
    state.output += chunk;
    if (state.outputByteLimit && state.outputByteLimit > 0) {
      const trimmed = trimOutputToLimit(state.output, state.outputByteLimit);
      state.output = trimmed.text;
      state.truncated = state.truncated || trimmed.truncated;
    }
  }

  private mergeTerminalEnv(
    env: Array<{ name: string; value: string }> | undefined,
  ): NodeJS.ProcessEnv {
    const resolved: NodeJS.ProcessEnv = { ...process.env };
    if (!env?.length) {
      return resolved;
    }
    for (const variable of env) {
      resolved[variable.name] = variable.value;
    }
    return resolved;
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

  private async createConnection(): Promise<void> {
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

function trimOutputToLimit(
  text: string,
  limit: number,
): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= limit) {
    return { text, truncated: false };
  }

  const slice = buffer.slice(buffer.length - limit);
  let start = 0;
  while (start < slice.length && (slice[start] & 0b11000000) === 0b10000000) {
    start += 1;
  }
  return {
    text: slice.toString("utf8", start),
    truncated: true,
  };
}
