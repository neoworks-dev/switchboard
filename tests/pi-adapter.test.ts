import { describe, expect, test } from "bun:test";
import { buildLaunch, EXTENSION_PATH } from "../src/adapters/pi/launch.ts";
import { HASHLINE_PI_EXTENSION } from "../src/hashline/index.ts";
import { needsApproval } from "../src/adapters/pi/bridge.ts";
import { stopReasonOf, toPiPrompt, toSessionUpdates, usageDelta } from "../src/adapters/pi/translate.ts";

describe("pi launch", () => {
  test("defaults: permission extension on, no version check", () => {
    expect(buildLaunch({})).toEqual({
      args: ["--extension", EXTENSION_PATH],
      env: { PI_SKIP_VERSION_CHECK: "1", NEOWORKS_PI_PERMISSIONS: "ask" },
    });
  });

  test("maps prompt, tools, model and effort to flags", () => {
    const { args } = buildLaunch({
      systemPrompt: { replace: "You are PhotoBot.", append: "Be terse." },
      tools: ["read", "shell", "web_search"],
      model: "openai-codex/gpt-6-luna",
      effort: "ultracode",
      permissions: "full-access",
    });
    expect(args).toEqual([
      "--system-prompt", "You are PhotoBot.",
      "--append-system-prompt", "Be terse.",
      "--tools", "read,grep,find,ls,bash",
      "--model", "openai-codex/gpt-6-luna",
      "--thinking", "xhigh",
    ]);
  });

  test("read-only narrows tools to readers, needs no extension", () => {
    const { args, env } = buildLaunch({ tools: ["read", "edit", "shell"], permissions: "read-only" });
    expect(args).toEqual(["--tools", "read,grep,find,ls"]);
    expect(env.NEOWORKS_PI_PERMISSIONS).toBeUndefined();
  });

  test("full isolation swaps the agent dir and drops discovered resources", () => {
    const { args, env } = buildLaunch({ isolation: "full", tools: "none", permissions: "full-access" }, { isolatedAgentDir: "/iso", resume: "s1" });
    expect(env.PI_CODING_AGENT_DIR).toBe("/iso");
    expect(args).toEqual([
      "--session", "s1",
      "--no-tools",
      "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes", "--no-approve",
    ]);
  });

  test("hooks load the extension even without a permission prompt", () => {
    const { args, env } = buildLaunch({ permissions: "full-access" }, { hooks: { address: "/run/h.sock", hooks: ["beforeToolUse", "onStop"] } });
    expect(args).toEqual(["--extension", EXTENSION_PATH]);
    expect(env).toMatchObject({ NEOWORKS_HOOK_SOCKET: "/run/h.sock", NEOWORKS_HOOKS: "beforeToolUse,onStop" });
    expect(env.NEOWORKS_PI_PERMISSIONS).toBeUndefined();
  });

  test("hashline edits load the hashline extension", () => {
    expect(buildLaunch({ edits: "hashline", permissions: "full-access" }).args).toEqual(["--extension", HASHLINE_PI_EXTENSION]);
    expect(buildLaunch({ edits: "hashline", tools: "none", permissions: "full-access" }).args).toEqual(["--no-tools"]);
  });

  test("permission policies", () => {
    expect(needsApproval("ask", "read")).toBe(false);
    expect(needsApproval("ask", "edit")).toBe(true);
    expect(needsApproval("auto-edit", "edit")).toBe(false);
    expect(needsApproval("auto-edit", "bash")).toBe(true);
    expect(needsApproval("auto-edit", "mcp_app_tool")).toBe(true);
    expect(needsApproval("auto-edit", "hashline_edit")).toBe(false);
    expect(needsApproval("ask", "hashline_read")).toBe(false);
  });
});

describe("pi translation", () => {
  test("prompt blocks become message text and images", () => {
    expect(
      toPiPrompt([
        { type: "text", text: "crop this" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
        { type: "resource", resource: { uri: "file:///a.ts", text: "const a = 1;" } },
      ]),
    ).toEqual({
      message: 'crop this\n\n<file uri="file:///a.ts">\nconst a = 1;\n</file>',
      images: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
    });
    expect(() => toPiPrompt([{ type: "audio", data: "", mimeType: "audio/wav" }])).toThrow("audio");
  });

  test("tool lifecycle becomes ACP tool_call updates", () => {
    const [call] = toSessionUpdates({
      type: "message_update",
      assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } } },
    });
    expect(call).toMatchObject({ sessionUpdate: "tool_call", toolCallId: "t1", title: "bash: ls", kind: "execute", status: "pending" });
    const [done] = toSessionUpdates({
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "a.ts" }] },
      isError: true,
    });
    expect(done).toMatchObject({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "failed" });
  });

  test("stop reasons", () => {
    const message = (stopReason: "stop" | "length" | "aborted" | "error") => ({ role: "assistant" as const, content: [], stopReason, usage: {} as never, errorMessage: "boom" });
    expect(stopReasonOf(message("stop"), false)).toBe("end_turn");
    expect(stopReasonOf(message("length"), false)).toBe("max_tokens");
    expect(stopReasonOf(message("stop"), true)).toBe("cancelled");
    expect(() => stopReasonOf(message("error"), false)).toThrow("boom");
  });

  test("usage is the delta between session totals", () => {
    const stats = (input: number, output: number) => ({ sessionId: "s", cost: 0, tokens: { input, output, cacheRead: 0, cacheWrite: 0, total: input + output } });
    expect(usageDelta(stats(10, 5), stats(25, 7))).toEqual({ inputTokens: 15, outputTokens: 2, cachedReadTokens: 0, cachedWriteTokens: 0, totalTokens: 17 });
  });
});
