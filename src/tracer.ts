// SPDX-License-Identifier: Apache-2.0
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { LogLevel, type LogOutputChannel } from "vscode";

const REDACTED = "<redacted>";

export class Tracer {
  constructor(private readonly channel: LogOutputChannel) {}

  trace(notification: SessionNotification): void {
    if (this.channel.logLevel === LogLevel.Trace) {
      const contentStr = JSON.stringify(this.redactLargeContent(notification));
      this.channel.trace(contentStr);
    }
  }

  private redactLargeContent(
    notification: SessionNotification,
  ): SessionNotification {
    const update = notification.update;
    switch (update.sessionUpdate) {
      case "tool_call":
      case "tool_call_update": {
        if (update.content) {
          for (const content of update.content) {
            switch (content.type) {
              case "content": {
                const value = content.content;
                switch (value.type) {
                  case "text": {
                    if (value.text) {
                      value.text = REDACTED;
                    }
                  }
                }
                break;
              }
              case "diff": {
                content.newText = content.newText ? REDACTED : content.newText;
                content.oldText = content.oldText ? REDACTED : content.oldText;
                break;
              }
            }
          }
        }

        if (update.rawOutput && this.isObject(update.rawOutput)) {
          if (this.isCommandPresent(update.rawOutput)) {
            // replace values start index 1
            update.rawOutput.command = update.rawOutput.command.map((v, i) => {
              if (i > 0) {
                return REDACTED;
              }
              return v;
            });
          }
          if (this.isFormattedOutputPresent(update.rawOutput)) {
            update.rawOutput.formatted_output = REDACTED;
          }
          if (this.isOutputPresent(update.rawOutput)) {
            update.rawOutput.output = REDACTED;
          }
          if (this.isAggregatedOutputPresent(update.rawOutput)) {
            update.rawOutput.aggregated_output = REDACTED;
          }
        }

        if (update.rawInput && this.isObject(update.rawInput)) {
          if (this.isCommandPresent(update.rawInput)) {
            // replace values start index 1
            update.rawInput.command = update.rawInput.command.map((v, i) => {
              if (i > 0) {
                return REDACTED;
              }
              return v;
            });
          }
        }
      }
    }

    return notification;
  }

  private isObject(input: unknown): input is object {
    return typeof input === "object";
  }

  private isCommandPresent(input: object): input is { command: string[] } {
    return (
      "command" in input &&
      Array.isArray(input.command) &&
      input.command.length > 0
    );
  }

  private isFormattedOutputPresent(
    rawOutput: object,
  ): rawOutput is { formatted_output: string } {
    return (
      "formatted_output" in rawOutput &&
      typeof rawOutput.formatted_output === "string"
    );
  }

  private isAggregatedOutputPresent(
    rawOutput: object,
  ): rawOutput is { aggregated_output: string } {
    return (
      "aggregated_output" in rawOutput &&
      typeof rawOutput.aggregated_output === "string"
    );
  }

  private isOutputPresent(rawOutput: object): rawOutput is { output: string } {
    return "output" in rawOutput && typeof rawOutput.output === "string";
  }
}
