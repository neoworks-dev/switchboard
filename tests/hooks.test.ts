import { describe, expect, test } from "bun:test";
import { commandHooks, fromCommandInput, toCommandOutput } from "../src/hooks/command-hooks.ts";

describe("command hook format", () => {
  test("hook table per registered hook", () => {
    const table = commandHooks(["beforeToolUse", "onPromptSubmit"], (hook) => `run ${hook}`);
    expect(table).toEqual({
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "run beforeToolUse", timeout: 600 }] }],
      UserPromptSubmit: [{ matcher: "*", hooks: [{ type: "command", command: "run onPromptSubmit", timeout: 600 }] }],
    });
  });

  test("reads harness input into neutral events", () => {
    const raw = { session_id: "s", cwd: "/w", tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "t", tool_response: "ok", stop_hook_active: true };
    expect(fromCommandInput("afterToolUse", raw, { harness: "claude" })).toEqual({
      sessionId: "s", harness: "claude", cwd: "/w", toolName: "Bash", input: { command: "ls" }, toolCallId: "t", result: "ok",
    });
    expect(fromCommandInput("onStop", raw, { harness: "codex" })).toEqual({ sessionId: "s", harness: "codex", cwd: "/w", continued: true });
  });

  test("blocks deny; nothing is ever allowed outright", () => {
    expect(toCommandOutput("claude", "beforeToolUse", { block: "no" })).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "no" },
    });
    expect(toCommandOutput("claude", "beforeToolUse", {})).toBeUndefined();
  });

  test("input rewrites: Claude without a decision, Codex under allow", () => {
    expect(toCommandOutput("claude", "beforeToolUse", { input: { a: 1 } })).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { a: 1 } } });
    expect(toCommandOutput("codex", "beforeToolUse", { input: { a: 1 } })).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { a: 1 } },
    });
  });

  test("context, prompt blocks and stop continuation", () => {
    expect(toCommandOutput("codex", "afterToolUse", { context: "c" })).toEqual({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "c" } });
    expect(toCommandOutput("claude", "onPromptSubmit", { block: "off topic" })).toEqual({ decision: "block", reason: "off topic" });
    expect(toCommandOutput("claude", "onStop", { continue: "run the tests" })).toEqual({ decision: "block", reason: "run the tests" });
  });
});
