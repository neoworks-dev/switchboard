import type { HarnessId } from "../options.ts";

/** Fields every hook event carries. */
export type HookContext = {
  /** ACP session id, the same one `Session.id` holds. */
  sessionId: string;
  harness: HarnessId;
  cwd?: string;
};

export type ToolUse = HookContext & {
  /** The harness's own tool name, e.g. `Bash`, `shell`, `bash`, `mcp__app__crop`. */
  toolName: string;
  input: Record<string, unknown>;
  toolCallId?: string;
};

export type ToolResult = ToolUse & { result: unknown };

export type PromptSubmit = HookContext & { prompt: string };

export type Stop = HookContext & {
  /** This turn already went on because of an earlier `continue`; guard against looping forever. */
  continued: boolean;
};

/**
 * Blocking hooks, run by the harness itself before it continues. Observing
 * without blocking needs no hook: every `session/update` is already on the
 * prompt's event stream.
 *
 * Returning nothing lets the harness carry on unchanged. Hooks never grant a
 * permission; the session's permission policy still applies.
 */
export type Hooks = {
  /** Before a tool runs. `block` refuses it and tells the model why; `input` replaces its arguments. */
  beforeToolUse?(event: ToolUse): HookReturn<{ block?: string; input?: Record<string, unknown> }>;
  /** After a tool ran. `context` is shown to the model alongside the result. */
  afterToolUse?(event: ToolResult): HookReturn<{ context?: string }>;
  /** Before a prompt reaches the model. `block` drops it; `context` is added to it. */
  onPromptSubmit?(event: PromptSubmit): HookReturn<{ block?: string; context?: string }>;
  /** When the model wants to end its turn. `continue` keeps it going with that instruction. */
  onStop?(event: Stop): HookReturn<{ continue?: string }>;
};

export type HookName = keyof Hooks;

export type HookReturn<T> = T | undefined | void | Promise<T | undefined | void>;

export type HookEvent<N extends HookName> = Parameters<NonNullable<Hooks[N]>>[0];

export type HookOutput<N extends HookName> = Exclude<Awaited<ReturnType<NonNullable<Hooks[N]>>>, undefined | void>;
