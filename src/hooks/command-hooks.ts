/**
 * The command-hook contract shared by Claude Code (Agent SDK `HookInput` /
 * `SyncHookJSONOutput`) and Codex (codex-rs/hooks, same shape), translated to
 * and from our harness-neutral hooks: JSON on stdin, JSON on stdout.
 */
import { nodeScript, siblingScript } from "../drivers/util.ts";
import type { HookContext, HookEvent, HookName, HookOutput } from "./types.ts";

export type CommandHookFormat = "claude" | "codex";

/** Hook event names, by our hook name. */
export const COMMAND_EVENTS = {
  beforeToolUse: "PreToolUse",
  afterToolUse: "PostToolUse",
  onPromptSubmit: "UserPromptSubmit",
  onStop: "Stop",
} as const satisfies Record<HookName, string>;

type CommandInput = {
  session_id: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  tool_response?: unknown;
  prompt?: string;
  stop_hook_active?: boolean;
};

const RUNNER = siblingScript(import.meta.url, "./runner");

/** Shell command that runs `runner.ts` for one hook against the server at `address`. */
export function runnerCommand(format: CommandHookFormat, address: string): (hook: HookName) => string {
  return (hook) => {
    const { command, args, env = {} } = nodeScript(RUNNER, [format, hook, address]);
    const assignments = Object.entries(env).map(([key, value]) => `${key}=${shellQuote(value)}`);
    return [...assignments, ...[command, ...args].map(shellQuote)].join(" ");
  };
}

/** POSIX single-quoting. Both harnesses run command hooks through `sh -c` outside Windows. */
function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/** A `hooks` config table running `command(hook)` for each hook the app registered. */
export function commandHooks(hooks: readonly HookName[], command: (hook: HookName) => string): Record<string, unknown> {
  return Object.fromEntries(
    hooks.map((hook) => [
      COMMAND_EVENTS[hook],
      // Hooks may wait on the user, e.g. an app dialog; give them ten minutes.
      [{ matcher: "*", hooks: [{ type: "command", command: command(hook), timeout: 600 }] }],
    ]),
  );
}

export function fromCommandInput<N extends HookName>(hook: N, raw: CommandInput, base: Omit<HookContext, "sessionId" | "cwd">): HookEvent<N> | undefined {
  const context: HookContext = { ...base, sessionId: raw.session_id, cwd: raw.cwd };
  const tool = { ...context, toolName: raw.tool_name ?? "", input: raw.tool_input ?? {}, toolCallId: raw.tool_use_id };
  switch (hook) {
    case "beforeToolUse":
      return tool as HookEvent<N>;
    case "afterToolUse":
      return { ...tool, result: raw.tool_response } as HookEvent<N>;
    case "onPromptSubmit":
      return { ...context, prompt: raw.prompt ?? "" } as HookEvent<N>;
    case "onStop":
      return { ...context, continued: raw.stop_hook_active ?? false } as HookEvent<N>;
  }
}

/**
 * Hook stdout. Never grants a permission: Claude skips its permission prompt on
 * `allow`, so input rewrites carry no decision there. Codex only accepts
 * rewrites under `allow`, which there leaves approval untouched.
 */
export function toCommandOutput<N extends HookName>(format: CommandHookFormat, hook: N, output: HookOutput<N> | undefined): Record<string, unknown> | undefined {
  if (!output) return undefined;
  const hookEventName = COMMAND_EVENTS[hook];
  switch (hook) {
    case "beforeToolUse": {
      const { block, input } = output as HookOutput<"beforeToolUse">;
      if (block) return { hookSpecificOutput: { hookEventName, permissionDecision: "deny", permissionDecisionReason: block } };
      if (!input) return undefined;
      const decision = format === "codex" ? { permissionDecision: "allow" } : {};
      return { hookSpecificOutput: { hookEventName, ...decision, updatedInput: input } };
    }
    case "afterToolUse": {
      const { context } = output as HookOutput<"afterToolUse">;
      return context ? { hookSpecificOutput: { hookEventName, additionalContext: context } } : undefined;
    }
    case "onPromptSubmit": {
      const { block, context } = output as HookOutput<"onPromptSubmit">;
      if (block) return { decision: "block", reason: block };
      return context ? { hookSpecificOutput: { hookEventName, additionalContext: context } } : undefined;
    }
    case "onStop": {
      const { continue: instruction } = output as HookOutput<"onStop">;
      return instruction ? { decision: "block", reason: instruction } : undefined;
    }
  }
}
