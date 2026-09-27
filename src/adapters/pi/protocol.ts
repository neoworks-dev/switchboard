/**
 * The subset of pi's RPC protocol this adapter speaks.
 *
 * Source of truth: packages/coding-agent/src/modes/rpc/rpc-types.ts and
 * docs/json.md in https://github.com/earendil-works/pi (checked against 0.87).
 */

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type ImageContent = { type: "image"; data: string; mimeType: string };

export type TextContent = { type: "text"; text: string };

export type ToolCall = { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";

export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number };

export type AssistantMessage = {
  role: "assistant";
  content: Array<TextContent | { type: "thinking"; thinking: string } | ToolCall>;
  stopReason: StopReason;
  errorMessage?: string;
  usage: Usage;
};

export type AgentMessage = AssistantMessage | { role: "user" | "toolResult" | (string & {}) };

export type ToolResult = { content: Array<TextContent | ImageContent>; details?: unknown };

export type Model = { id: string; name: string; provider: string };

export type SessionState = {
  sessionId: string;
  sessionFile?: string;
  model?: Model;
  isStreaming: boolean;
  thinkingLevel: ThinkingLevel;
};

export type SessionStats = {
  sessionId: string;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
};

/** Command name → parameters and the `data` of its success response. */
export type Commands = {
  prompt: {
    params: { message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" };
    /** pi < 0.87.1 replies without data, which means "started". */
    result: { disposition: "started" | "queued" | "handled" } | undefined;
  };
  steer: { params: { message: string; images?: ImageContent[] }; result: { disposition: "queued" | "handled" } };
  abort: { params: Record<string, never>; result: undefined };
  get_state: { params: Record<string, never>; result: SessionState };
  get_session_stats: { params: Record<string, never>; result: SessionStats };
  get_available_models: { params: Record<string, never>; result: { models: Model[] } };
  set_thinking_level: { params: { level: ThinkingLevel }; result: undefined };
};

export type CommandType = keyof Commands;

export type Response =
  | { type: "response"; id?: string; command: string; success: true; data?: unknown }
  | { type: "response"; id?: string; command: string; success: false; error: string };

export type AssistantMessageEvent =
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall }
  | { type: "start" | "text_start" | "text_end" | "thinking_start" | "thinking_end" | "toolcall_start" | "toolcall_delta" | "done" | "error" };

/** Session events the adapter reacts to. Others are dropped at the framing layer. */
export type Event =
  | { type: "message_update"; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: ToolResult; isError: boolean }
  | { type: "agent_settled" };

export const EVENT_TYPES: ReadonlySet<string> = new Set<Event["type"]>([
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_end",
  "agent_settled",
]);

/** Extension dialogs forwarded over RPC; fire-and-forget methods (notify, setStatus, …) need no reply. */
export type UiRequest =
  | { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string }
  | { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[] }
  | { type: "extension_ui_request"; id: string; method: "input" | "editor"; title: string }
  | { type: "extension_ui_request"; id: string; method: "notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text" };

export type UiResponse =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true };
