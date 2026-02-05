// SPDX-License-Identifier: Apache-2.0
import { ToolCall, ToolCallUpdate } from "@agentclientprotocol/sdk";
import * as vscode from "vscode";

const DEFAULT_TERMINAL_LANGUAGE = "shell";

export type ToolInfo = {
  name: string;
  kind: string;
  input?: string;
  output?: string;
};

export function getToolInfo(
  toolCallUpdate: ToolCallUpdate | ToolCall,
): ToolInfo {
  const response: ToolInfo = {
    name: toolCallUpdate.title || "",
    kind: toolCallUpdate.kind || "terminal",
  };

  if (
    toolCallUpdate.status === "in_progress" ||
    toolCallUpdate.status === "pending"
  ) {
    if (
      toolCallUpdate.rawInput &&
      typeof toolCallUpdate.rawInput === "object" &&
      "command" in toolCallUpdate.rawInput &&
      Array.isArray(toolCallUpdate.rawInput.command)
    ) {
      response.input = toolCallUpdate.rawInput.command.join(" ");
    } else {
      toolCallUpdate.content
        ?.filter((c) => c.type === "content")
        .map((c) => c.content)
        .filter((c) => c.type === "text")
        .reduce((acc, curr) => {
          response.input = acc + curr.text;
          return response.input;
        }, "");
    }
    if (response.name === "" && response.input) {
      const firstLine = response.input.split("\n")[0];
      response.name =
        firstLine.length > 30 ? firstLine.substring(0, 30) + "..." : firstLine;
    }
  } else {
    if (
      toolCallUpdate.rawOutput &&
      typeof toolCallUpdate.rawOutput === "object"
    ) {
      if (
        "command" in toolCallUpdate.rawOutput &&
        Array.isArray(toolCallUpdate.rawOutput.command)
      ) {
        response.input = toolCallUpdate.rawOutput.command.join(" ");
        if (response.name === "") {
          const firstLine = response.input.split("\n")[0];
          response.name =
            firstLine.length > 30
              ? firstLine.substring(0, 30) + "..."
              : firstLine;
        }
      }

      if (
        "formatted_output" in toolCallUpdate.rawOutput &&
        typeof toolCallUpdate.rawOutput.formatted_output === "string"
      ) {
        response.output = toolCallUpdate.rawOutput.formatted_output;
      } else if (
        "aggregated_output" in toolCallUpdate.rawOutput &&
        typeof toolCallUpdate.rawOutput.aggregated_output === "string"
      ) {
        response.output = toolCallUpdate.rawOutput.aggregated_output;
      } else if (
        "output" in toolCallUpdate.rawOutput &&
        typeof toolCallUpdate.rawOutput.output === "string"
      ) {
        response.output = toolCallUpdate.rawOutput.output;
      } else {
        response.output = `${JSON.stringify(toolCallUpdate.rawOutput, null, 2)}`;
      }
    } else {
      toolCallUpdate.content
        ?.filter((c) => c.type === "content")
        .map((c) => c.content)
        .filter((c) => c.type === "text")
        .reduce((acc, curr) => {
          response.output = acc + curr.text;
          return response.output;
        }, "");
    }
  }

  return response;
}

type ToolCommandPayload = {
  command?: unknown;
};

function getCommandLine(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const { command } = raw as ToolCommandPayload;
  if (!Array.isArray(command)) {
    return undefined;
  }
  const parts = command.filter((part) => typeof part === "string") as string[];
  if (!parts.length) {
    return undefined;
  }
  return parts.join(" ");
}

export function getSubAgentInvocationId(
  toolCallUpdate: ToolCallUpdate | ToolCall,
): string | undefined {
  const meta = toolCallUpdate._meta;
  if (!meta || typeof meta !== "object") {
    return undefined;
  }
  const { subAgentInvocationId } = meta as { subAgentInvocationId?: unknown };
  return typeof subAgentInvocationId === "string"
    ? subAgentInvocationId
    : undefined;
}

export function isTerminalToolInvocation(
  toolCallUpdate: ToolCallUpdate | ToolCall,
  info: ToolInfo,
): boolean {
  return (
    info.kind === "execute" ||
    Boolean(getCommandLine(toolCallUpdate.rawInput)) ||
    Boolean(getCommandLine(toolCallUpdate.rawOutput))
  );
}

export function buildTerminalToolInvocationData(
  toolCallUpdate: ToolCallUpdate | ToolCall,
  info: ToolInfo,
): vscode.ChatTerminalToolInvocationData | undefined {
  const commandLine =
    getCommandLine(toolCallUpdate.rawInput) ||
    getCommandLine(toolCallUpdate.rawOutput) ||
    info.input;
  if (!commandLine) {
    return undefined;
  }

  const data: vscode.ChatTerminalToolInvocationData = {
    language: DEFAULT_TERMINAL_LANGUAGE,
    commandLine: {
      original: commandLine,
    },
  };

  if (info.output) {
    data.output = { text: info.output };
  }

  if (
    toolCallUpdate.rawOutput &&
    typeof toolCallUpdate.rawOutput === "object"
  ) {
    const rawOutput = toolCallUpdate.rawOutput as {
      exitCode?: unknown;
      duration?: unknown;
    };
    const exitCode =
      typeof rawOutput.exitCode === "number" ? rawOutput.exitCode : undefined;
    const duration =
      typeof rawOutput.duration === "number" ? rawOutput.duration : undefined;
    if (exitCode !== undefined || duration !== undefined) {
      data.state = { exitCode, duration };
    }
  }

  return data;
}

export function buildMcpToolInvocationData(
  info: ToolInfo,
): vscode.ChatMcpToolInvocationData | undefined {
  if (!info.input && !info.output) {
    return undefined;
  }

  const output: vscode.McpToolInvocationContentData[] = [];
  if (info.output) {
    const encoder = new TextEncoder();
    output.push({
      data: encoder.encode(info.output),
      mimeType: "text/plain",
    });
  }

  return {
    input: info.input ?? "",
    output,
  };
}

export function buildDiffMarkdown(
  path: string,
  oldText: string | undefined,
  newText: string | undefined,
): vscode.MarkdownString | undefined {
  const diffBody = toInlineDiff(oldText ?? "", newText ?? "");
  if (!diffBody) {
    return undefined;
  }

  const diffMarkdown = new vscode.MarkdownString();
  diffMarkdown.appendMarkdown("**");
  diffMarkdown.appendText(path);
  diffMarkdown.appendMarkdown("**\n\n");
  diffMarkdown.appendCodeblock(diffBody, "diff");
  return diffMarkdown;
}

export function toInlineDiff(oldText: string, newText: string): string {
  const normalize = (text: string): string => text.replace(/\r\n?/g, "\n");
  const original = normalize(oldText);
  const updated = normalize(newText);

  if (original === updated) {
    return "";
  }

  const oldLines = original.split("\n");
  const newLines = updated.split("\n");
  const m = oldLines.length;
  const n = newLines.length;

  const lcs = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );

  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        lcs[i][j] = lcs[i + 1][j + 1] + 1;
      } else {
        lcs[i][j] = Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
  }

  type DiffOp = { type: "common" | "add" | "remove"; line: string };
  const script: DiffOp[] = [];
  let i = 0;
  let j = 0;

  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      script.push({ type: "common", line: oldLines[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      script.push({ type: "remove", line: oldLines[i] });
      i++;
    } else {
      script.push({ type: "add", line: newLines[j] });
      j++;
    }
  }

  while (i < m) {
    script.push({ type: "remove", line: oldLines[i] });
    i++;
  }
  while (j < n) {
    script.push({ type: "add", line: newLines[j] });
    j++;
  }

  const hasChanges = script.some((part) => part.type !== "common");
  if (!hasChanges) {
    return "";
  }

  const diffLines: string[] = ["--- original", "+++ modified"];
  const oldStart = m > 0 ? 1 : 0;
  const newStart = n > 0 ? 1 : 0;
  diffLines.push(`@@ -${oldStart},${m} +${newStart},${n} @@`);

  for (const part of script) {
    const prefix =
      part.type === "add" ? "+" : part.type === "remove" ? "-" : " ";
    diffLines.push(`${prefix}${part.line}`);
  }

  return diffLines.join("\n");
}

export function normalizeDiffPath(path: string): string {
  const normalized = path.replace(/^file:\/\//, "");
  return normalized.startsWith("/") ? normalized.slice(1) : normalized;
}

export function resolveDiffUri(
  path: string,
  workspaceRoot: vscode.Uri | undefined,
): vscode.Uri {
  if (path.includes("://")) {
    return vscode.Uri.parse(path);
  }
  if (workspaceRoot) {
    return vscode.Uri.joinPath(workspaceRoot, normalizeDiffPath(path));
  }
  return vscode.Uri.file(normalizeDiffPath(path));
}

export function buildDiffStats(
  oldText: string | undefined,
  newText: string | undefined,
): { added: number; removed: number } {
  const normalize = (text: string): string => text.replace(/\r\n?/g, "\n");
  const original = normalize(oldText ?? "");
  const updated = normalize(newText ?? "");
  if (original === updated) {
    return { added: 0, removed: 0 };
  }
  const oldLines = original.split("\n");
  const newLines = updated.split("\n");
  const m = oldLines.length;
  const n = newLines.length;
  const lcs = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        lcs[i][j] = lcs[i + 1][j + 1] + 1;
      } else {
        lcs[i][j] = Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
  }
  let i = 0;
  let j = 0;
  let removed = 0;
  let added = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      removed++;
      i++;
    } else {
      added++;
      j++;
    }
  }
  removed += m - i;
  added += n - j;
  return { added, removed };
}
