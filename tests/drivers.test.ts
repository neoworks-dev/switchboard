import { describe, expect, test } from "bun:test";
import { claude, claudeOptions } from "../src/drivers/claude.ts";
import { codex, codexConfig, pickCodexMode } from "../src/drivers/codex.ts";

const CTX = { cwd: "/tmp" };

describe("claude driver", () => {
  test("no options → no adapter meta", () => {
    expect(claude.sessionMeta({}, CTX)).toBeUndefined();
  });

  test("maps options onto Agent SDK options", () => {
    expect(
      claude.sessionMeta({
        systemPrompt: { replace: "You are PhotoBot." },
        tools: ["read", "shell"],
        model: "haiku",
        effort: "low",
        isolation: "full",
        limits: { maxTurns: 3, maxBudgetUsd: 0.5 },
      }, CTX),
    ).toEqual({
      claudeCode: {
        options: {
          systemPrompt: "You are PhotoBot.",
          tools: ["Read", "Glob", "Grep", "Bash"],
          model: "haiku",
          effort: "low",
          settingSources: [],
          strictMcpConfig: true,
          maxTurns: 3,
          maxBudgetUsd: 0.5,
        },
      },
    });
  });

  test("append-only keeps the Claude Code preset", () => {
    expect(claude.sessionMeta({ systemPrompt: { append: "Be terse." }, tools: "none" }, CTX)).toEqual({
      claudeCode: { options: { systemPrompt: { type: "preset", preset: "claude_code", append: "Be terse." }, tools: [] } },
    });
  });

  test("one process for every config", async () => {
    expect(await claude.spawn({ model: "a" }, CTX)).toEqual(await claude.spawn({ model: "b", tools: "none" }, CTX));
  });
});

describe("codex driver", () => {
  test("no options → unfiltered MCP and no config override", async () => {
    const spec = await codex.spawn({}, CTX);
    expect(spec.env).toEqual({ DISABLE_MCP_CONFIG_FILTERING: "true" });
  });

  test("puts prompt, tools, model and effort into CODEX_CONFIG", async () => {
    const spec = await codex.spawn({
      systemPrompt: { replace: "base", append: "dev" },
      tools: ["read"],
      model: "gpt-5.6-luna",
      effort: "max",
    }, CTX);
    const { hooks, ...config } = JSON.parse(spec.env!.CODEX_CONFIG!);
    expect(config).toEqual({
      instructions: "base",
      developer_instructions: "dev",
      features: { shell_tool: false, multi_agent: false, image_generation: false, view_image: false, goals: false },
      agents: { enabled: false },
      web_search: "disabled",
      model: "gpt-5.6-luna",
      model_reasoning_effort: "xhigh",
      bypass_hook_trust: true,
    });
    // No edit tool asked for, and no switch removes apply_patch: a hook refuses it.
    expect(hooks.PreToolUse).toMatchObject([{ matcher: "apply_patch" }]);
  });

  test("the default tool set keeps apply_patch", () => {
    expect(codexConfig({ tools: ["read", "edit"] }, CTX).config.hooks).toBeUndefined();
    expect(codexConfig({}, CTX).config.hooks).toBeUndefined();
  });

  test("tools none drops Codex's sandbox and mode instructions", async () => {
    const config = JSON.parse((await codex.spawn({ tools: "none" }, CTX)).env!.CODEX_CONFIG!);
    expect(config).toMatchObject({
      include_permissions_instructions: false,
      include_collaboration_mode_instructions: false,
      agents: { enabled: false },
      features: { shell_tool: false, view_image: false, tool_suggest: false },
    });
  });

  test("full isolation strips skills, plugins and project docs", async () => {
    const config = JSON.parse((await codex.spawn({ isolation: "full" }, CTX)).env!.CODEX_CONFIG!);
    expect(config).toEqual({
      project_doc_max_bytes: 0,
      skills: { bundled: { enabled: false }, include_instructions: false },
      features: { skill_search: false, plugins: false, apps: false, recommended_plugins: false },
    });
  });

  test("permissions pick a user-reviewed mode by kind, across adapter versions", () => {
    const mode = (id: string, kind: string) => ({ id, name: id, _meta: { kind } });
    // codex-acp 1.13.1: "read-only" is workspace-write + user review.
    const v1_13 = [mode("read-only", "standard"), mode("agent", "auto_review"), mode("agent-full-access", "full_access")];
    expect(pickCodexMode(v1_13, "ask")).toBe("read-only");
    expect(pickCodexMode(v1_13, "full-access")).toBe("agent-full-access");
    // Newer: separate read-only and workspace-write.
    const next = [mode("read-only", "standard"), mode("workspace-write", "standard"), ...v1_13.slice(1)];
    expect(pickCodexMode(next, "ask")).toBe("workspace-write");
    expect(pickCodexMode(next, "read-only")).toBe("read-only");
    expect(pickCodexMode([mode("agent", "auto_review")], "ask")).toBeUndefined();
  });

  test("distinct configs get distinct processes", async () => {
    expect(await codex.spawn({ model: "a" }, CTX)).not.toEqual(await codex.spawn({ model: "b" }, CTX));
  });
});

describe("tuning", () => {
  test("claude: disabled features become disallowed tools, settings and env", () => {
    const options = claudeOptions({ disable: ["subagents", "workflows", "tool_search", "memory"] }, CTX);
    expect(options.disallowedTools).toEqual(["Agent", "SendMessage", "ListAgents", "Workflow", "ToolSearch"]);
    expect(options.settings).toEqual({ disableWorkflows: true, workflowKeywordTriggerEnabled: false, autoMemoryEnabled: false });
    expect(options.env).toEqual({ ENABLE_TOOL_SEARCH: "false" });
  });

  test("claude: ultracode and disabled workflows share one settings object", () => {
    expect(claudeOptions({ effort: "ultracode", disable: ["workflows"] }, CTX).settings).toMatchObject({ ultracode: true, disableWorkflows: true });
  });

  test("claude: hashline replaces Read and Edit with MCP tools", () => {
    const options = claudeOptions({ edits: "hashline", permissions: "auto-edit" }, CTX);
    expect(options.disallowedTools).toEqual(["Read", "Edit"]);
    expect(options.allowedTools).toEqual(["mcp__hashline__read", "mcp__hashline__edit"]);
    expect(claude.mcpServers!({ edits: "hashline" }, CTX)).toMatchObject([{ name: "hashline" }]);
    expect(claude.mcpServers!({}, CTX)).toEqual([]);
  });

  test("claude: read-only hashline keeps its edit tool out", () => {
    expect(claudeOptions({ edits: "hashline", permissions: "read-only" }, CTX).disallowedTools).toEqual(["Read", "Edit", "mcp__hashline__edit"]);
  });

  test("claude: hooks are command hooks in flag settings", () => {
    const options = claudeOptions({}, { cwd: "/tmp", hooks: { address: "/run/h.sock", hooks: ["beforeToolUse", "onStop"] } });
    const hooks = (options.settings as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }).hooks;
    expect(Object.keys(hooks)).toEqual(["PreToolUse", "Stop"]);
    expect(hooks.PreToolUse![0]!.hooks[0]!.command).toEndWith("runner.ts claude beforeToolUse /run/h.sock");
  });

  test("codex: disabled features deep-merge into config", () => {
    const { config } = codexConfig({ disable: ["subagents", "todos", "user_questions", "images"] }, CTX);
    expect(config).toEqual({
      features: { multi_agent: false, goals: false, image_generation: false, view_image: false },
      agents: { enabled: false },
      tools: { update_plan: { enabled: false }, experimental_request_user_input: { enabled: false } },
    });
  });

  test("codex: hooks and the apply_patch refusal share PreToolUse and bypass trust", () => {
    const { config } = codexConfig({ edits: "hashline" }, { cwd: "/tmp", hooks: { address: "/run/h.sock", hooks: ["beforeToolUse"] } });
    const pre = (config.hooks as Record<string, Array<{ matcher: string }>>).PreToolUse!;
    expect(pre.map((group) => group.matcher)).toEqual(["*", "apply_patch"]);
    expect(config.bypass_hook_trust).toBe(true);
  });

  test("codex: no hooks, no trust bypass", () => {
    expect(codexConfig({}, CTX).config.bypass_hook_trust).toBeUndefined();
  });
});
