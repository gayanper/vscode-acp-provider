// SPDX-License-Identifier: Apache-2.0
import {
  AgentCapabilities,
  Client,
  ContentBlock,
  LoadSessionResponse,
  NewSessionResponse,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionInfo,
  SessionModelState,
  SessionModeState,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import * as vscode from "vscode";
import { AgentRegistryEntry } from "./agentRegistry";
import { DisposableBase } from "./disposables";
import { AcpClient, AcpPermissionHandler } from "./acpClient";

const STREAM_DELAY_MS = 500;
const DEFAULT_STOP_RESPONSE: PromptResponse = { stopReason: "end_turn" };

type NotificationSequence = ReadonlyArray<SessionNotification>;
type NotificationPhase = keyof PromptNotificationPlan;

type NotificationSource = NotificationSequence | PromptNotificationPlan;

export interface PromptNotificationPlan {
  readonly prompt?: NotificationSequence;
  readonly permissionAllowed?: NotificationSequence;
  readonly permissionDenied?: NotificationSequence;
}

export interface PreprogrammedPermissionConfig {
  readonly title: string;
  readonly rawInput: {
    readonly command: string[];
  };
}

export interface PreprogrammedPromptProgram {
  readonly promptText: string;
  readonly notifications?: NotificationSource;
  readonly response?: PromptResponse;
  readonly permission?: PreprogrammedPermissionConfig;
  readonly permissions?: readonly PreprogrammedPermissionConfig[];
  readonly notificationSteps?: readonly PromptNotificationPlan[];
}

export interface PreprogrammedSessionConfig {
  readonly sessionId: string;
  readonly cwd?: string;
  readonly label?: string;
  readonly models?: SessionModelState;
  readonly modes?: SessionModeState;
}

export interface PreprogrammedConfig {
  readonly agent?: AgentRegistryEntry;
  readonly agentCapabilities?: AgentCapabilities;
  readonly session: PreprogrammedSessionConfig;
  readonly promptPrograms?: Array<PreprogrammedPromptProgram>;
  readonly permissionHandler: AcpPermissionHandler;
  readonly sessionToResume: PreprogrammedSessionConfig & {
    turns: NotificationSequence;
  };
}

class PreprogrammedAcpClient extends DisposableBase implements AcpClient {
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

  private readonly promptPrograms = new Map<
    string,
    PreprogrammedPromptProgram
  >();
  private readonly agentCapabilities?: AgentCapabilities;
  private readonly permissionHandler: AcpPermissionHandler;

  private readonly sessionId: string;
  private readonly label: string;
  private cwd: string;
  private readonly models?: SessionModelState;
  private readonly modes?: SessionModeState;
  private sessionCreated = false;
  private currentProgram?: PreprogrammedPromptProgram;

  constructor(private readonly config: PreprogrammedConfig) {
    super();
    this.agentCapabilities = config.agentCapabilities;
    this.permissionHandler = config.permissionHandler;

    const sessionConfig = config.session;
    this.sessionId = sessionConfig.sessionId;
    this.cwd = sessionConfig.cwd ?? "";
    this.label = sessionConfig.label ?? this.sessionId;
    this.models = sessionConfig.models;
    this.modes = sessionConfig.modes;

    for (const program of config.promptPrograms ?? []) {
      const key = this.normalizePrompt(program.promptText);
      this.promptPrograms.set(key, program);
    }
  }

  async ensureReady(): Promise<void> {
    this._onDidStart.fire();
    return Promise.resolve();
  }

  getCapabilities(): AgentCapabilities {
    return this.agentCapabilities || {};
  }

  async createSession(
    cwd: string,
    _mcpServers: AgentRegistryEntry["mcpServers"],
  ): Promise<NewSessionResponse> {
    await this.ensureReady();

    if (!this.sessionCreated) {
      this.sessionCreated = true;
      if (!this.cwd) {
        this.cwd = cwd;
      }
    }

    this._onDidOptionsChanged.fire();

    return {
      sessionId: this.sessionId,
      models: this.models,
      modes: this.modes,
    } satisfies NewSessionResponse;
  }

  async loadSession(
    sessionId: string,
    _cwd: string,
    _mcpServers: AgentRegistryEntry["mcpServers"],
  ): Promise<{
    modeId: string | undefined;
    modelId: string | undefined;
    notifications: SessionNotification[];
  }> {
    await this.ensureReady();
    if (sessionId !== this.config.sessionToResume.sessionId) {
      throw new Error(`Unknown session ${sessionId}`);
    }

    this._onDidOptionsChanged.fire();
    return {
      modeId: this.config.sessionToResume.modes?.currentModeId,
      modelId: this.config.sessionToResume.models?.currentModelId,
      notifications: [...this.config.sessionToResume.turns],
    };
  }

  async prompt(
    sessionId: string,
    promptBlocks: ContentBlock[],
  ): Promise<PromptResponse> {
    await this.ensureReady();
    if (sessionId !== this.sessionId) {
      throw new Error(`Unknown session ${sessionId}`);
    }

    const normalizedPrompt = this.normalizePrompt(
      this.extractPromptText(promptBlocks),
    );
    const program = this.promptPrograms.get(normalizedPrompt);
    if (!program) {
      throw new Error(
        `No preprogrammed response for prompt: "${normalizedPrompt}"`,
      );
    }

    this.currentProgram = program;

    if (this.currentProgram.permissions?.length) {
      const permissions = this.currentProgram.permissions;
      for (let index = 0; index < permissions.length; index += 1) {
        const permission = permissions[index];
        const response = await this.requestPermission({
          options: [
            {
              kind: "allow_always",
              name: "Allow",
              optionId: "allow",
            },
            {
              kind: "reject_always",
              name: "Reject",
              optionId: "deny",
            },
          ],
          sessionId: this.sessionId,
          toolCall: {
            toolCallId: `preprogrammed-tool-call-${index + 1}`,
            title: permission.title,
            rawInput: permission.rawInput,
          },
        });

        if (response.outcome.outcome !== "selected") {
          throw new Error("Permission request was not completed");
        }

        const stepPlan =
          this.currentProgram.notificationSteps?.[index] ??
          (this.currentProgram.notifications as
            | PromptNotificationPlan
            | undefined);
        if (response.outcome.optionId === "allow") {
          await this.streamNotificationPlan(stepPlan, "permissionAllowed");
        } else {
          await this.streamNotificationPlan(stepPlan, "permissionDenied");
        }
      }
    } else if (this.currentProgram.permission) {
      const permission = this.currentProgram.permission;
      const response = await this.requestPermission({
        options: [
          {
            kind: "allow_always",
            name: "Allow",
            optionId: "allow",
          },
          {
            kind: "reject_always",
            name: "Reject",
            optionId: "deny",
          },
        ],
        sessionId: this.sessionId,
        toolCall: {
          toolCallId: "preprogrammed-tool-call",
          title: permission.title,
          rawInput: permission.rawInput,
        },
      });

      if (response.outcome.outcome === "selected") {
        const plan = program.notifications as PromptNotificationPlan;
        if (response.outcome.optionId === "allow") {
          await this.streamNotificationPlan(plan, "permissionAllowed");
        } else {
          await this.streamNotificationPlan(plan, "permissionDenied");
        }
      } else {
        throw new Error("Permission request was not completed");
      }
    } else {
      await this.streamNotificationPlan(program.notifications, "prompt");
    }
    return program.response ?? DEFAULT_STOP_RESPONSE;
  }

  async cancel(_sessionId: string): Promise<void> {
    return;
  }

  async requestPermission(
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    return this.permissionHandler.requestPermission(request);
  }

  async sessionUpdate(notification: SessionNotification): Promise<void> {
    this.onSessionUpdateEmitter.fire(this.ensureSessionId(notification));
  }

  async changeMode(_sessionId: string, _modeId: string): Promise<void> {
    return;
  }

  async changeModel(_sessionId: string, _modelId: string): Promise<void> {
    return;
  }

  dispose(): void {
    this.onSessionUpdateEmitter.dispose();
    this._onDidStop.dispose();
    super.dispose();
  }

  private async streamNotificationPlan(
    plan: NotificationSource | undefined,
    phase: NotificationPhase,
  ): Promise<void> {
    if (!plan) {
      return;
    }

    if (Array.isArray(plan)) {
      if (phase === "prompt") {
        await this.streamNotifications(plan);
      }
      return;
    }

    const notifications = (plan as PromptNotificationPlan)[phase];
    if (!notifications) {
      return;
    }

    await this.streamNotifications(notifications);
  }

  getSupportedModeState(): SessionModeState | null {
    return this.modes || null;
  }

  getSupportedModelState(): SessionModelState | null {
    return this.models || null;
  }

  private async streamNotifications(
    notifications: NotificationSequence,
  ): Promise<void> {
    for (const notification of notifications) {
      await this.delay(STREAM_DELAY_MS);
      this.onSessionUpdateEmitter.fire(this.ensureSessionId(notification));
    }
  }

  private ensureSessionId(
    notification: SessionNotification,
  ): SessionNotification {
    if (notification.sessionId) {
      return notification;
    }
    return { ...notification, sessionId: this.sessionId };
  }

  private normalizePrompt(input: string): string {
    return input.trim().replace(/\s+/g, " ");
  }

  private extractPromptText(blocks: ContentBlock[]): string {
    const pieces: string[] = [];
    for (const block of blocks.reverse()) {
      if (
        block.type === "text" &&
        block.text &&
        block.text.startsWith("User: ")
      ) {
        pieces.push(block.text.substring("User: ".length).trim());
        break;
      }
    }
    if (pieces.length === 0) {
      return "";
    }
    return pieces.join("\n");
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export function createPreprogrammedAcpClient(
  config: PreprogrammedConfig,
): AcpClient {
  return new PreprogrammedAcpClient(config);
}
