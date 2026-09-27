/**
 * The SDK contract, shared by the in-process `Harness` and the remote
 * `HarnessClient`. Type-only, so browser bundles can import it.
 */
import type * as acp from "@agentclientprotocol/sdk";
import type { Hooks } from "./hooks/types.ts";
import type { Effort, HarnessId, SessionOptions } from "./options.ts";

export type { BuiltinTool, EditMode, Effort, Feature, HarnessId, PermissionPolicy, SessionOptions } from "./options.ts";
export type { HookContext, HookName, Hooks, PromptSubmit, Stop, ToolResult, ToolUse } from "./hooks/types.ts";

/** How faithfully a harness can honor each `SessionOptions` field. */
export type Support = "session" | "process" | "partial" | "none";

export type Capabilities = {
  systemPromptReplace: Support;
  systemPromptAppend: Support;
  tools: Support;
  model: Support;
  effort: Support;
  isolation: Support;
  permissions: Support;
  limits: Support;
  images: boolean;
  audio: boolean;
  resume: boolean;
  fork: boolean;
  cost: boolean;
};

export type Usage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  costUsd?: number;
};

export type PromptResult = { stopReason: acp.StopReason; usage?: Usage; response: acp.PromptResponse };

/** Events a session emits while a prompt turn runs. */
export type HarnessEvent =
  | { type: "update"; update: acp.SessionUpdate }
  | { type: "permission"; request: acp.RequestPermissionRequest }
  | ({ type: "done" } & PromptResult);

/** Shorthand answers to a permission request, or a full ACP response. */
export type PermissionReply = "once" | "always" | "reject" | "cancel" | acp.RequestPermissionResponse;

export type PermissionHandler = (request: acp.RequestPermissionRequest) => PermissionReply | Promise<PermissionReply>;

export type HarnessInfo = {
  id: HarnessId;
  available: boolean;
  detail?: string;
  capabilities: Capabilities;
  /** Effort levels worth offering; others map to the nearest one. */
  efforts: readonly Effort[];
};

export type ModelInfo = { id: string; name: string; description?: string };

export type SessionInit = {
  /** Defaults to the configured harness, else `claude`. */
  harness?: HarnessId;
  /**
   * Absolute working directory of the session. Defaults to the harness process's own
   * (the sidecar's, for `HarnessClient`), fine for sessions without file tools.
   */
  cwd?: string;
  /** Typically the calling app's own MCP server, so the harness can act on the app. */
  mcpServers?: acp.McpServer[];
  options?: SessionOptions;
  /** Answers tool permission requests. Without one, every request is rejected. */
  onPermission?: PermissionHandler;
  /** Blocking hooks, run by the harness itself. See `Hooks`. */
  hooks?: Hooks;
};

/**
 * One prompt turn. Iterate it for events as they stream, await it for the
 * result, or both. Leaving the iteration before the end cancels the turn.
 */
export interface PromptRun extends AsyncIterable<HarnessEvent>, PromiseLike<PromptResult> {}

export interface HarnessSession {
  readonly id: string;
  readonly harness: HarnessId;
  prompt(content: string | acp.ContentBlock[]): PromptRun;
  /** Every event of every turn, including permission requests. Returns the unsubscribe function. */
  onEvent(listener: (event: HarnessEvent) => void): () => void;
  cancel(): Promise<void>;
  /** Stop routing events and hooks here. The harness keeps the session for `resumeSession`. */
  close(): Promise<void>;
}

/** What apps program against, whether the harnesses run in-process or behind a sidecar. */
export interface HarnessApi {
  listHarnesses(): Promise<HarnessInfo[]>;
  /** Models the harness offers under the user's login. May start the harness to ask it. */
  listModels(harness: HarnessId): Promise<ModelInfo[]>;
  createSession(init: SessionInit): Promise<HarnessSession>;
  /** Reattach to an earlier session. Options and MCP servers are not remembered, so pass them again. */
  resumeSession(sessionId: string, init: SessionInit): Promise<HarnessSession>;
  close(): Promise<void>;
}
