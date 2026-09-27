import * as acp from "@agentclientprotocol/sdk";
import type { AssistantMessage, Event, ImageContent, SessionStats, ToolResult } from "./protocol.ts";

const TOOL_KINDS: Record<string, acp.ToolKind> = {
  read: "read",
  grep: "search",
  find: "search",
  ls: "search",
  edit: "edit",
  write: "edit",
  bash: "execute",
  powershell: "execute",
  hashline_read: "read",
  hashline_edit: "edit",
};

export function toolKind(toolName: string): acp.ToolKind {
  return TOOL_KINDS[toolName] ?? "other";
}

export function toolTitle(toolName: string, input: Record<string, unknown>): string {
  const subject = input.command ?? input.path ?? input.pattern;
  return typeof subject === "string" ? `${toolName}: ${subject}` : toolName;
}

/** ACP prompt blocks → pi `prompt` command. Unsupported content fails loudly instead of vanishing. */
export function toPiPrompt(blocks: acp.ContentBlock[]): { message: string; images: ImageContent[] } {
  const parts: string[] = [];
  const images: ImageContent[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        parts.push(block.text);
        break;
      case "image":
        images.push({ type: "image", data: block.data, mimeType: block.mimeType });
        break;
      case "resource_link":
        parts.push(`<file uri="${block.uri}" />`);
        break;
      case "resource":
        if (!("text" in block.resource)) throw acp.RequestError.invalidParams(undefined, "pi cannot read binary resources");
        parts.push(`<file uri="${block.resource.uri}">\n${block.resource.text}\n</file>`);
        break;
      case "audio":
        throw acp.RequestError.invalidParams(undefined, "pi does not accept audio");
    }
  }
  return { message: parts.join("\n\n"), images };
}

export function toSessionUpdates(event: Event): acp.SessionUpdate[] {
  switch (event.type) {
    case "message_update": {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta") return [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: update.delta } }];
      if (update.type === "thinking_delta") return [{ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: update.delta } }];
      if (update.type === "toolcall_end") {
        const { id, name, arguments: input } = update.toolCall;
        return [{ sessionUpdate: "tool_call", toolCallId: id, title: toolTitle(name, input), kind: toolKind(name), status: "pending", rawInput: input }];
      }
      return [];
    }
    case "tool_execution_start":
      return [{ sessionUpdate: "tool_call_update", toolCallId: event.toolCallId, status: "in_progress" }];
    case "tool_execution_end":
      return [
        {
          sessionUpdate: "tool_call_update",
          toolCallId: event.toolCallId,
          status: event.isError ? "failed" : "completed",
          content: toolResultContent(event.result),
          rawOutput: event.result,
        },
      ];
    default:
      return [];
  }
}

function toolResultContent(result: ToolResult): acp.ToolCallContent[] {
  return result.content.map((block) => ({
    type: "content",
    content: block.type === "text" ? { type: "text", text: block.text } : { type: "image", data: block.data, mimeType: block.mimeType },
  }));
}

/** How a settled run ended. An `error` stop is a failed request, not a stop reason. */
export function stopReasonOf(last: AssistantMessage | undefined, cancelled: boolean): acp.StopReason {
  if (cancelled || last?.stopReason === "aborted") return "cancelled";
  if (last?.stopReason === "error") throw acp.RequestError.internalError(undefined, last.errorMessage ?? "pi reported an error");
  if (last?.stopReason === "length") return "max_tokens";
  return "end_turn";
}

/** pi reports session totals; ACP wants this turn's usage. */
export function usageDelta(before: SessionStats | undefined, after: SessionStats): acp.Usage {
  const was = before?.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const now = after.tokens;
  return {
    inputTokens: now.input - was.input,
    outputTokens: now.output - was.output,
    cachedReadTokens: now.cacheRead - was.cacheRead,
    cachedWriteTokens: now.cacheWrite - was.cacheWrite,
    totalTokens: now.total - was.total,
  };
}

export function usageUpdate(stats: SessionStats): acp.SessionUpdate {
  return {
    sessionUpdate: "usage_update",
    used: stats.contextUsage?.tokens ?? stats.tokens.total,
    size: stats.contextUsage?.contextWindow ?? 0,
    cost: { amount: stats.cost, currency: "USD" },
  };
}
