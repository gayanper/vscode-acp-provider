import { SessionNotification } from "@agentclientprotocol/sdk";
import * as vscode from "vscode";

/**
 * Builds VS Code chat turns from ACP session notification events.
 */
export class TurnBuilder {
  private currentUserMessage = "";
  private currentAgentParts: Array<
    vscode.ChatResponseMarkdownPart | vscode.ChatResponseProgressPart
  > = [];
  private processedMessages = new Set<string>();
  private agentMessageChunks: string[] = [];
  private turns: Array<vscode.ChatRequestTurn2 | vscode.ChatResponseTurn2> = [];
  private participantId: string;

  constructor(participantId: string) {
    this.participantId = participantId;
  }

  processNotification(notification: SessionNotification): void {
    const update = notification.update;

    switch (update.sessionUpdate) {
      case "user_message_chunk": {
        this.flushPendingAgentMessage();
        // a poor effort to only filter the user prompt. We do see that the user prompt comes first, so lets use that.
        // if we think we need other information later, we will find a way to add them.
        if (this.currentUserMessage === "") {
          const text =
            update.content.type === "text" ? update.content.text : "";
          // some cleanup for user message
          if (text.startsWith("User:")) {
            this.currentUserMessage += text.replace("User:", "").trimStart();
          } else {
            this.currentUserMessage += text;
          }
        }
        break;
      }

      case "agent_message_chunk": {
        this.flushPendingUserMessage();

        const text = update.content.type === "text" ? update.content.text : "";
        this.agentMessageChunks.push(text);
        break;
      }

      case "agent_thought_chunk": {
        this.flushPendingUserMessage();

        const thought =
          update.content.type === "text" ? update.content.text : "";
        if (thought.trim()) {
          this.currentAgentParts.push(
            new vscode.ChatResponseProgressPart(thought),
          );
        }
        break;
      }

      case "tool_call": {
        this.flushPendingUserMessage();
        // TODO: Use ChatToolInvocationPart once available in stable API
        const toolName = update.toolCallId || "tool";
        const toolMsg = `🔧 ${toolName}`;
        this.currentAgentParts.push(
          new vscode.ChatResponseMarkdownPart(
            new vscode.MarkdownString(toolMsg),
          ),
        );
        break;
      }

      case "tool_call_update": {
        // Tool updates would be handled here when ChatToolInvocationPart is available
        // for now use markdown parts to represent tool call updates
        this.flushPendingUserMessage();

        const toolName = update.toolCallId || "tool";
        const toolMsg = `🔧 ${toolName} (updated)`;
        this.currentAgentParts.push(
          new vscode.ChatResponseMarkdownPart(
            new vscode.MarkdownString(toolMsg),
          ),
        );
        break;
      }

      case "plan": {
        // implement this using markdown checkbox list
        this.flushPendingUserMessage();
        update.entries.forEach((entry) => {
          const planMsg = `- [ ] ${entry}`;
          this.currentAgentParts.push(
            new vscode.ChatResponseMarkdownPart(
              new vscode.MarkdownString(planMsg),
            ),
          );
        });
        break;
      }
      // Ignore other session update types for history
      case "available_commands_update":
      case "current_mode_update":
      case "config_option_update":
      case "session_info_update":
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
    this.currentAgentParts = [];
    this.processedMessages.clear();
    this.agentMessageChunks = [];
    this.turns = [];
  }

  private flushPendingUserMessage(): void {
    if (this.currentUserMessage.trim()) {
      this.turns.push(
        new vscode.ChatRequestTurn2(
          this.currentUserMessage,
          undefined, // command
          [], // references
          this.participantId,
          [], // toolReferences
          undefined, // editedFileEvents
        ),
      );
      this.currentUserMessage = "";
    }
  }

  private flushPendingAgentMessage(): void {
    if (this.agentMessageChunks.length > 0) {
      const content = this.agentMessageChunks.join("");
      if (content.trim()) {
        this.currentAgentParts.push(
          new vscode.ChatResponseMarkdownPart(
            new vscode.MarkdownString(content),
          ),
        );
      }
      this.agentMessageChunks = [];
    }

    if (this.currentAgentParts.length > 0) {
      this.turns.push(
        new vscode.ChatResponseTurn2(
          this.currentAgentParts,
          {}, // result
          this.participantId,
        ),
      );
      this.currentAgentParts = [];
    }
  }
}
