// SPDX-License-Identifier: Apache-2.0
import type { SessionNotification } from "@agentclientprotocol/sdk";
import assert from "node:assert/strict";
import Module from "node:module";
import { setup, suite, teardown, test } from "mocha";
import type { LogOutputChannel } from "vscode";

import type { Tracer as TracerType } from "./tracer";

const REDACTED = "<redacted>";
const TRACE_LOG_LEVEL = 1;
const moduleWithLoad = Module as typeof Module & {
  _load: (
    request: string,
    parent: NodeModule | null | undefined,
    isMain: boolean,
  ) => unknown;
};
const originalLoad = moduleWithLoad._load;

let Tracer: typeof TracerType;

setup(() => {
  moduleWithLoad._load = (
    request: string,
    parent: NodeModule | null | undefined,
    isMain: boolean,
  ) => {
    if (request === "vscode") {
      return { LogLevel: { Trace: TRACE_LOG_LEVEL } };
    }
    return originalLoad(request, parent, isMain);
  };

  delete require.cache[require.resolve("./tracer")];
  Tracer = (require("./tracer") as { Tracer: typeof TracerType }).Tracer;
});

teardown(() => {
  moduleWithLoad._load = originalLoad;
  delete require.cache[require.resolve("./tracer")];
});

function createTraceChannel(traceLogs: string[]): LogOutputChannel {
  return {
    logLevel: TRACE_LOG_LEVEL,
    trace(value: string): void {
      traceLogs.push(value);
    },
  } as unknown as LogOutputChannel;
}

function createToolCallNotification(): SessionNotification {
  return {
    sessionId: "session-1",
    update: {
      sessionUpdate: "tool_call",
      title: "run command",
      toolCallId: "tool-1",
      content: [
        {
          type: "content",
          content: {
            type: "text",
            text: "sensitive text",
          },
        },
        {
          type: "diff",
          path: "file.txt",
          oldText: "old secret",
          newText: "new secret",
        },
      ],
      rawInput: {
        command: ["bash", "--api-key", "secret-key"],
      },
      rawOutput: {
        command: ["bash", "--token", "secret-token"],
        formatted_output: "formatted secret output",
        output: "secret output",
        aggregated_output: "aggregated secret output",
      },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

suite("Tracer", () => {
  test("trace does not mutate input notification", () => {
    const traceLogs: string[] = [];
    const channel = createTraceChannel(traceLogs);

    const tracer = new Tracer(channel);
    const notification = createToolCallNotification();

    const originalNotification = structuredClone(notification);
    tracer.trace(notification);

    assert.deepEqual(notification, originalNotification);
    assert.equal(traceLogs.length, 1);
  });

  test("trace redacts sensitive fields before logging", () => {
    const traceLogs: string[] = [];
    const channel = createTraceChannel(traceLogs);

    const tracer = new Tracer(channel);
    tracer.trace(createToolCallNotification());

    assert.equal(traceLogs.length, 1);
    const loggedNotification = JSON.parse(traceLogs[0]) as SessionNotification;

    assert.equal(loggedNotification.update.sessionUpdate, "tool_call");
    if (loggedNotification.update.sessionUpdate !== "tool_call") {
      assert.fail("expected sessionUpdate to be a tool_call");
    }

    const textContent = loggedNotification.update.content?.[0];
    if (
      !(textContent?.type === "content" && textContent.content.type === "text")
    ) {
      assert.fail("expected text content in first tool-call content item");
    }
    assert.equal(textContent.content.text, REDACTED);

    const diffContent = loggedNotification.update.content?.[1];
    if (diffContent?.type !== "diff") {
      assert.fail("expected diff content in second tool-call content item");
    }
    assert.equal(diffContent.newText, REDACTED);
    assert.equal(diffContent.oldText, REDACTED);

    if (
      !isRecord(loggedNotification.update.rawInput) ||
      !Array.isArray(loggedNotification.update.rawInput.command)
    ) {
      assert.fail("expected redacted rawInput command array");
    }
    assert.deepEqual(loggedNotification.update.rawInput.command, [
      "bash",
      REDACTED,
      REDACTED,
    ]);

    if (
      !isRecord(loggedNotification.update.rawOutput) ||
      !Array.isArray(loggedNotification.update.rawOutput.command)
    ) {
      assert.fail("expected redacted rawOutput object");
    }
    assert.deepEqual(loggedNotification.update.rawOutput.command, [
      "bash",
      REDACTED,
      REDACTED,
    ]);
    assert.equal(
      loggedNotification.update.rawOutput.formatted_output,
      REDACTED,
    );
    assert.equal(loggedNotification.update.rawOutput.output, REDACTED);
    assert.equal(
      loggedNotification.update.rawOutput.aggregated_output,
      REDACTED,
    );
  });
});
