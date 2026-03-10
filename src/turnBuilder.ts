// SPDX-License-Identifier: Apache-2.0
import {
  ContentBlock,
  SessionNotification,
  ToolCall,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import * as vscode from "vscode";
import {
  buildDiffStats,
  buildMcpToolInvocationData,
  buildQuestionCarouselPart,
  buildTerminalToolInvocationData,
  getSubAgentInvocationId,
  getToolInfo,
  isTerminalToolInvocation,
  resolveUri,
} from "./chatRenderingUtils";
import { createDiffUri, setDiffContent } from "./diffContentProvider";
import { currentWorkspaceRoot } from "./types";
type ParsedUserMessage = {
  userMessages: string;
  references: vscode.ChatPromptReference[];
};
/**
 * Builds VS Code chat turns from ACP session notification events.
 */
export class TurnBuilder {
  private currentUserMessage = "";
  private currentUserReferences: vscode.ChatPromptReference[] = [];
  private currentAgentParts: vscode.ExtendedChatResponsePart[] = [];
  private currentAgentMetadata: Record<string, unknown> = {};
  private agentMessageChunks: string[] = [];
  private turns: Array<vscode.ChatRequestTurn2 | vscode.ChatResponseTurn2> = [];
  private readonly toolCallParts = new Map<
    string,
    {
      part: vscode.ChatToolInvocationPart;
      invocationMessage?: string;
    }
  >();
  private readonly questionToolCalls = new Set<string>();

  constructor(
    private readonly participantId: string,
    private readonly logger: vscode.LogOutputChannel,
  ) {}

  processNotification(notification: SessionNotification): void {
    const update = notification.update;

    switch (update.sessionUpdate) {
      case "user_message_chunk": {
        this.flushPendingAgentMessage();
        this.captureUserMessageChunk(update.content);
        break;
      }

      case "agent_message_chunk": {
        this.flushPendingUserMessage();
        this.captureAgentMessageChunk(update.content);
        break;
      }

      case "agent_thought_chunk": {
        this.flushPendingUserMessage();
        this.flushAgentMessageChunksToMarkdown();

        const thought = this.getContentText(update.content);
        if (thought?.trim()) {
          this.currentAgentParts.push(
            new vscode.ChatResponseProgressPart(thought.trim()),
          );
        }
        break;
      }

      case "tool_call": {
        this.flushPendingUserMessage();
        this.flushAgentMessageChunksToMarkdown();
        this.appendToolCall(update as ToolCall);
        break;
      }

      case "tool_call_update": {
        this.flushPendingUserMessage();
        this.flushAgentMessageChunksToMarkdown();
        this.appendToolUpdate(update as ToolCallUpdate);
        break;
      }

      case "plan": {
        this.flushPendingUserMessage();
        this.flushAgentMessageChunksToMarkdown();
        this.appendPlanEntries(update.entries);
        break;
      }

      // Ignore other session update types for history
      case "available_commands_update":
      case "current_mode_update":
      case "config_option_update":
      case "session_info_update":
      case "usage_update":
        break;
    }
  }

  getTurns(): Array<vscode.ChatRequestTurn2 | vscode.ChatResponseTurn2> {
    this.flushPendingUserMessage();
    this.flushPendingAgentMessage();

    return [...this.turns];
  }

  reset(): void {
    this.currentUserMessage = "";
    this.currentUserReferences = [];
    this.currentAgentParts = [];
    this.currentAgentMetadata = {};
    this.agentMessageChunks = [];
    this.turns = [];
    this.toolCallParts.clear();
    this.questionToolCalls.clear();
  }

  private captureUserMessageChunk(content?: ContentBlock): void {
    const text = this.getContentText(content);
    if (!text) {
      return;
    }
    const parsed = this.parseUserChunk(text);
    if (parsed.userMessages) {
      this.currentUserMessage += parsed.userMessages;
    }
    if (parsed.references.length) {
      this.currentUserReferences.push(...parsed.references);
    }
  }

  private captureAgentMessageChunk(content?: ContentBlock): void {
    const text = this.getContentText(content);
    if (text) {
      this.agentMessageChunks.push(text);
    }
  }

  private appendToolCall(update: ToolCall): void {
    const info = getToolInfo(update);
    const invocation = new vscode.ChatToolInvocationPart(
      info.name || "Tool",
      update.toolCallId,
    );
    invocation.originMessage = info.name || "Tool";
    if (info.input) {
      invocation.invocationMessage = info.input;
    }
    const subAgentInvocationId = getSubAgentInvocationId(update);
    if (subAgentInvocationId) {
      invocation.subAgentInvocationId = subAgentInvocationId;
    }
    this.toolCallParts.set(update.toolCallId, {
      part: invocation,
      invocationMessage: info.input,
    });
    this.currentAgentParts.push(invocation);
  }

  private appendToolUpdate(update: ToolCallUpdate): void {
    const tracked = this.toolCallParts.get(update.toolCallId);
    if (!tracked) {
      return;
    }
    const part = tracked.part;

    const info = getToolInfo(update);
    if (update.status !== "completed" && update.status !== "failed") {
      if (!this.questionToolCalls.has(update.toolCallId)) {
        const questionPart = buildQuestionCarouselPart(update);
        if (questionPart) {
          this.currentAgentParts.push(questionPart);
          this.questionToolCalls.add(update.toolCallId);
        }
      }
      if (info.input) {
        part.invocationMessage = info.input;
        tracked.invocationMessage = info.input;
      }
      return;
    }

    this.questionToolCalls.delete(update.toolCallId);

    part.isConfirmed = update.status === "completed";
    part.isError = update.status === "failed" ? true : false;
    part.isComplete = true;
    const invocationMessage = info.input ?? tracked.invocationMessage;
    if (invocationMessage) {
      part.invocationMessage = invocationMessage;
    }
    if (info.output) {
      part.pastTenseMessage = info.output;
    }
    if (update.status === "completed") {
      part.presentation = "hiddenAfterComplete";
    }
    const subAgentInvocationId = getSubAgentInvocationId(update);
    if (subAgentInvocationId) {
      part.subAgentInvocationId = subAgentInvocationId;
    }
    const terminalData = isTerminalToolInvocation(update, info)
      ? buildTerminalToolInvocationData(update, info)
      : undefined;
    part.toolSpecificData = terminalData ?? buildMcpToolInvocationData(info);
    this.toolCallParts.delete(update.toolCallId);

    if (!update.content?.length) {
      return;
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    const diffEntries: vscode.ChatResponseDiffEntry[] = [];
    let diffIndex = 0;
    for (const content of update.content) {
      if (content.type !== "diff") {
        continue;
      }

      const oldText = content.oldText ?? "";
      const newText = content.newText ?? "";
      const hasOriginal = content.oldText !== undefined;
      const hasModified = content.newText !== undefined;
      const isDeletion =
        hasOriginal &&
        (content.newText === "" || content.newText === undefined);
      const fileUri = resolveUri(content.path, workspaceRoot);
      const originalUri = hasOriginal
        ? createDiffUri({
            side: "original",
            toolCallId: update.toolCallId,
            fileUri,
            index: diffIndex,
          })
        : undefined;
      const modifiedUri = hasModified
        ? createDiffUri({
            side: "modified",
            toolCallId: update.toolCallId,
            fileUri,
            index: diffIndex,
          })
        : undefined;
      if (originalUri) {
        setDiffContent(originalUri, oldText);
      }
      if (modifiedUri) {
        setDiffContent(modifiedUri, newText);
      }
      diffEntries.push({
        originalUri,
        modifiedUri,
        goToFileUri: fileUri,
        ...buildDiffStats(
          content.oldText ?? undefined,
          content.newText ?? undefined,
        ),
      });

      diffIndex++;
    }

    if (diffEntries.length) {
      this.currentAgentParts.push(
        new vscode.ChatResponseMultiDiffPart(
          diffEntries,
          vscode.l10n.t("File edits"),
          true,
        ),
      );
    }
  }

  private appendPlanEntries(
    entries: Array<{ content: string; status?: string }>,
  ): void {
    if (!entries.length) {
      return;
    }

    const markdown = new vscode.MarkdownString();
    markdown.appendMarkdown("## Plan\n");
    for (const entry of entries) {
      const checkbox = entry.status === "completed" ? "x" : " ";
      markdown.appendMarkdown(`-  [${checkbox}] ${entry.content}\n`);
    }
    this.currentAgentParts.push(new vscode.ChatResponseMarkdownPart(markdown));
  }

  private flushPendingUserMessage(): void {
    if (!this.currentUserMessage.trim()) {
      return;
    }

    this.turns.push(
      new vscode.ChatRequestTurn2(
        this.currentUserMessage,
        undefined,
        this.currentUserReferences,
        this.participantId,
        [],
        undefined,
      ),
    );
    this.currentUserMessage = "";
    this.currentUserReferences = [];
  }

  private flushAgentMessageChunksToMarkdown(): void {
    if (!this.agentMessageChunks.length) {
      return;
    }

    const markdown = new vscode.MarkdownString();
    markdown.appendMarkdown(this.agentMessageChunks.join(""));
    this.agentMessageChunks = [];
    this.currentAgentParts.push(new vscode.ChatResponseMarkdownPart(markdown));
  }

  private flushPendingAgentMessage(): void {
    this.flushAgentMessageChunksToMarkdown();

    if (!this.currentAgentParts.length) {
      return;
    }

    const result: vscode.ChatResult =
      Object.keys(this.currentAgentMetadata).length > 0
        ? { metadata: this.currentAgentMetadata }
        : {};
    const responseTurn = new vscode.ChatResponseTurn2(
      this.currentAgentParts,
      result,
      this.participantId,
    );
    this.turns.push(responseTurn);
    this.currentAgentParts = [];
    this.currentAgentMetadata = {};
  }

  private getContentText(content?: ContentBlock): string | undefined {
    if (!content) {
      return undefined;
    }
    if (content.type === "text") {
      return content.text;
    }
    return undefined;
  }

  private parseUserChunk(raw: string): ParsedUserMessage {
    const colonOutput = this.parseColonSeparatedUserChunk(raw);
    if (colonOutput.userMessages || colonOutput.references.length) {
      this.logger.debug("User message chunk parsed using Colon format");
      return colonOutput;
    }

    const xmlOutput = this.parseXmlLineUserChunk(raw);
    if (xmlOutput.userMessages || xmlOutput.references.length) {
      this.logger.debug("User message chunk parsed using XML format");
      return xmlOutput;
    }

    this.logger.debug(
      "User message chunk could not be parsed, returning raw value",
    );
    return {
      userMessages: raw,
      references: [],
    };
  }

  private parseXmlLineUserChunk(raw: string): ParsedUserMessage {
    const workspaceRoot = currentWorkspaceRoot();
    const references: vscode.ChatPromptReference[] = [];

    let userMessages = raw;

    const extractTagValue = (tagName: string): string | undefined => {
      const match = raw.match(
        new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "i"),
      );
      return match?.[1]?.trim();
    };

    const commandMessage = extractTagValue("command-message");
    const commandName = extractTagValue("command-name");
    const commandArgs = extractTagValue("command-args");

    const normalizeCommandName = (value: string): string =>
      value.replace(/^(?:\.\/|\/)+/, "").trim();

    let slashCommand = "";
    if (commandMessage) {
      const normalized = commandMessage.trim();
      if (normalized.startsWith("./")) {
        slashCommand = `/${normalizeCommandName(normalized)}`;
      } else if (normalized.startsWith("/")) {
        slashCommand = `/${normalizeCommandName(normalized)}`;
      } else {
        slashCommand = `/${normalizeCommandName(normalized)}`;
      }
    } else if (commandName) {
      slashCommand = `/${normalizeCommandName(commandName)}`;
    }

    if (slashCommand && commandArgs) {
      slashCommand = `${slashCommand} ${commandArgs}`;
    } else if (!slashCommand && commandArgs) {
      slashCommand = ` ${commandArgs}`;
    }

    userMessages = userMessages
      .replace(/<command-message>[\s\S]*?<\/command-message>/gi, "")
      .replace(/<command-name>[\s\S]*?<\/command-name>/gi, "")
      .replace(/<command-args>[\s\S]*?<\/command-args>/gi, "");

    const contextTagPattern = /<context\s+ref="([^"]+)"[\s\S]*?<\/context>/g;
    userMessages = userMessages.replace(contextTagPattern, (_match, ref) => {
      const uri = resolveUri(ref, workspaceRoot);
      if (uri) {
        const name = vscode.workspace.asRelativePath(uri, false);
        references.push({
          id: name,
          name,
          value: uri,
        });
      }
      return "";
    });

    const markdownRefPattern = /\[@([^\]]+)\]\(([^)]+)\)/g;
    userMessages = userMessages.replace(
      markdownRefPattern,
      (_match, name, ref) => {
        const uri = resolveUri(ref, workspaceRoot);
        if (uri) {
          references.push({
            id: name,
            name,
            value: uri,
          });
        }
        return "";
      },
    );

    const cleanedMessage = userMessages.trim();

    return {
      userMessages: slashCommand
        ? cleanedMessage
          ? `${slashCommand}\n${cleanedMessage}`
          : slashCommand
        : cleanedMessage,
      references,
    };
  }

  private parseColonSeparatedUserChunk(raw: string): ParsedUserMessage {
    const REF = "Reference ";

    if (raw.startsWith("User:")) {
      const refStart = Math.max(raw.indexOf(REF), 0);
      return {
        userMessages: raw
          .substring(0, refStart > 0 ? refStart : raw.length)
          .replace(/^User:\s*/, "")
          .trim(),
        references: [],
      };
    }

    if (raw.startsWith(REF)) {
      const match = raw.match(/Reference\s\((.*)\):\s(.*)/);
      if (match) {
        const fileUri = resolveUri(match[1], currentWorkspaceRoot());
        const fileRelative = match[2];
        if (fileUri) {
          return {
            userMessages: "",
            references: [
              {
                id: fileRelative,
                name: fileRelative,
                value: fileUri,
              },
            ],
          };
        }
      }
    }

    return {
      userMessages: "",
      references: [],
    };
  }
}
