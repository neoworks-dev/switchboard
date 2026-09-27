/**
 * pi extension, loaded with `-e`, that gives pi what the other harnesses have
 * built in: a permission prompt (pi has no approval system) and blocking
 * hooks, both answered by the ACP side. Configured through env, see bridge.ts.
 */
import type { HookName } from "../../hooks/types.ts";
import { callHook } from "../../hooks/wire.ts";
import {
  HOOK_SOCKET_ENV,
  HOOKS_ENV,
  needsApproval,
  PERMISSION_POLICY_ENV,
  PERMISSION_TITLE,
  type BridgedPolicy,
  type PermissionQuestion,
} from "./bridge.ts";

// Minimal structural slice of pi's ExtensionAPI, so this file needs no pi dependency.
type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type Context = {
  cwd: string;
  sessionManager: { getSessionId(): string };
  ui: { confirm(title: string, message: string): Promise<boolean> };
};
type ToolCallEvent = { toolCallId: string; toolName: string; input: Record<string, unknown> };
type ToolResultEvent = ToolCallEvent & { content: Content[]; isError: boolean };
type InputEvent = { text: string; source: "interactive" | "rpc" | "extension" };
type CustomMessage = { type: "custom_message"; customType: string; content: string; display: boolean };
type Handler<E, R> = (event: E, ctx: Context) => Promise<R | undefined>;
type ExtensionAPI = {
  on(event: "tool_call", handler: Handler<ToolCallEvent, { block: true; reason: string }>): void;
  on(event: "tool_result", handler: Handler<ToolResultEvent, { content: Content[] }>): void;
  on(event: "input", handler: Handler<InputEvent, { action: "handled" } | { action: "transform"; text: string }>): void;
  on(event: "agent_before_settle", handler: Handler<unknown, { continue: true; entries: CustomMessage[] }>): void;
};

export default function neoworks(pi: ExtensionAPI): void {
  const policy = process.env[PERMISSION_POLICY_ENV] as BridgedPolicy | undefined;
  const address = process.env[HOOK_SOCKET_ENV];
  const hooks = new Set((process.env[HOOKS_ENV] ?? "").split(",").filter(Boolean) as HookName[]);
  const ask = <N extends HookName>(hook: N, ctx: Context, event: Record<string, unknown>) =>
    address && hooks.has(hook)
      ? callHook(address, { hook, event: { sessionId: ctx.sessionManager.getSessionId(), harness: "pi", cwd: ctx.cwd, ...event } as never })
      : Promise.resolve(undefined);

  pi.on("tool_call", async (event, ctx) => {
    // Hooks run before the permission prompt, as in Claude Code and Codex.
    const hooked = await ask("beforeToolUse", ctx, { toolName: event.toolName, input: event.input, toolCallId: event.toolCallId });
    if (hooked?.block) return { block: true, reason: hooked.block };
    if (hooked?.input) {
      // pi reads arguments from this object after the handler; it must be patched in place.
      for (const key of Object.keys(event.input)) delete event.input[key];
      Object.assign(event.input, hooked.input);
    }

    if (!policy || !needsApproval(policy, event.toolName)) return undefined;
    const question: PermissionQuestion = { toolCallId: event.toolCallId, toolName: event.toolName, input: event.input };
    const approved = await ctx.ui.confirm(PERMISSION_TITLE, JSON.stringify(question));
    return approved ? undefined : { block: true, reason: "The user declined this tool call." };
  });

  pi.on("tool_result", async (event, ctx) => {
    const hooked = await ask("afterToolUse", ctx, {
      toolName: event.toolName,
      input: event.input,
      toolCallId: event.toolCallId,
      result: { content: event.content, isError: event.isError },
    });
    return hooked?.context ? { content: [...event.content, { type: "text", text: hooked.context }] } : undefined;
  });

  let continued = false;
  pi.on("input", async (event, ctx) => {
    continued = false;
    const hooked = await ask("onPromptSubmit", ctx, { prompt: event.text });
    if (hooked?.block) return { action: "handled" };
    return hooked?.context ? { action: "transform", text: `${event.text}\n\n${hooked.context}` } : undefined;
  });

  pi.on("agent_before_settle", async (_event, ctx) => {
    const hooked = await ask("onStop", ctx, { continued });
    if (!hooked?.continue) return undefined;
    continued = true;
    return { continue: true, entries: [{ type: "custom_message", customType: "neoworks-stop-hook", content: hooked.continue, display: true }] };
  });
}
