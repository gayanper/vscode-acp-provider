// SPDX-License-Identifier: Apache-2.0
import {
  ContentBlock,
  ToolCall,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import * as vscode from "vscode";

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

export function renderContentBlockAsMarkdown(
  content: ContentBlock,
): vscode.MarkdownString | undefined {
  if (content.type === "text") {
    return new vscode.MarkdownString(content.text);
  }

  if (content.type === "resource_link") {
    return renderResourceMarkdown({
      uri: content.uri,
      title: content.title ?? content.name ?? content.uri,
      description: content.description ?? undefined,
    });
  }

  if (content.type === "resource") {
    const resource = content.resource as {
      uri?: string;
      text?: string;
      blob?: string;
      mimeType?: string;
    };
    const title = resource.uri ?? "resource";
    const description = resource.text
      ? truncatePreview(resource.text)
      : resource.mimeType
        ? `Binary resource (${resource.mimeType})`
        : "Embedded resource";
    return renderResourceMarkdown({
      uri: resource.uri,
      title,
      description,
    });
  }

  return undefined;
}

export function renderContentBlockAsPlainText(
  content: ContentBlock,
): string | undefined {
  if (content.type === "text") {
    return content.text;
  }

  if (content.type === "resource_link") {
    const title = content.title ?? content.name ?? content.uri;
    const details = content.description ? ` - ${content.description}` : "";
    return `${title}: ${content.uri}${details}`;
  }

  if (content.type === "resource") {
    const resource = content.resource as {
      uri?: string;
      text?: string;
      mimeType?: string;
    };
    const title = resource.uri ?? "resource";
    const description = resource.text
      ? truncatePreview(resource.text)
      : resource.mimeType
        ? `Binary resource (${resource.mimeType})`
        : "Embedded resource";
    return `${title}: ${resource.uri ?? ""}${description ? ` - ${description}` : ""}`.trim();
  }

  return undefined;
}

function renderResourceMarkdown(params: {
  uri?: string;
  title: string;
  description?: string;
}): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString();
  const label = params.title || params.uri || "resource";
  if (params.uri) {
    markdown.appendMarkdown(`[${label}](${params.uri})`);
  } else {
    markdown.appendText(label);
  }
  if (params.description) {
    markdown.appendMarkdown(` - ${params.description}`);
  }
  return markdown;
}

function truncatePreview(text: string, limit: number = 200): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit)}...`;
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
