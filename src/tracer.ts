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
    const snCopy = {
      ...notification,
    };

    const update = {
      ...snCopy.update,
    };
    snCopy.update = update;

    switch (update.sessionUpdate) {
      case "tool_call":
      case "tool_call_update": {
        if (update.content) {
          const cArrayCopy = [];
          for (const content of update.content) {
            const cCopy = { ...content };
            cArrayCopy.push(cCopy);

            switch (cCopy.type) {
              case "content": {
                const value = cCopy.content;
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
                cCopy.newText = cCopy.newText ? REDACTED : cCopy.newText;
                cCopy.oldText = cCopy.oldText ? REDACTED : cCopy.oldText;
                break;
              }
            }
          }
          update.content = cArrayCopy;
        }

        if (update.rawOutput && this.isObject(update.rawOutput)) {
          const rawOutCopy = { ...update.rawOutput };
          if (this.isCommandPresent(rawOutCopy)) {
            // replace values start index 1
            rawOutCopy.command = rawOutCopy.command.map((v, i) => {
              if (i > 0) {
                return REDACTED;
              }
              return v;
            });
          }
          if (this.isFormattedOutputPresent(rawOutCopy)) {
            rawOutCopy.formatted_output = REDACTED;
          }
          if (this.isOutputPresent(rawOutCopy)) {
            rawOutCopy.output = REDACTED;
          }
          if (this.isAggregatedOutputPresent(rawOutCopy)) {
            rawOutCopy.aggregated_output = REDACTED;
          }
          update.rawOutput = rawOutCopy;
        }

        if (update.rawInput && this.isObject(update.rawInput)) {
          const rawInputCopy = { ...update.rawInput };
          if (this.isCommandPresent(rawInputCopy)) {
            // replace values start index 1
            rawInputCopy.command = rawInputCopy.command.map((v, i) => {
              if (i > 0) {
                return REDACTED;
              }
              return v;
            });
          }
          update.rawInput = rawInputCopy;
        }
      }
    }

    return snCopy;
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
