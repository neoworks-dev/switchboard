import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { hashlineMcpServer, hashlineToolset } from "../hashline/index.ts";
import { commandHooks, runnerCommand } from "../hooks/command-hooks.ts";
import { disabledFeatures } from "../options.ts";
import type { BuiltinTool, Effort, Feature, PermissionPolicy, SessionOptions } from "../types.ts";
import type { Driver, DriverContext } from "./types.ts";
import { nodeScript, packageBin } from "./util.ts";

// Codex tops out at xhigh.
const EFFORT: Record<Effort, string> = { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "xhigh", ultracode: "xhigh" };

/** Config overrides that switch each feature off (codex 0.156). */
const FEATURES: Record<Feature, Record<string, unknown>> = {
  // The model catalog can switch multi-agent V2 on regardless of features; only `agents` overrides it.
  subagents: { features: { multi_agent: false }, agents: { enabled: false } },
  workflows: {},
  todos: { features: { goals: false }, tools: { update_plan: { enabled: false } } },
  scheduling: { features: { sleep_tool: false } },
  worktrees: {},
  plan_mode: { include_collaboration_mode_instructions: false },
  skills: { skills: { bundled: { enabled: false }, include_instructions: false }, features: { skill_search: false } },
  memory: { features: { memories: false } },
  tool_search: { features: { tool_suggest: false } },
  images: { features: { image_generation: false, view_image: false } },
  user_questions: { tools: { experimental_request_user_input: { enabled: false } } },
};

/**
 * Codex offers apply_patch whenever it has a workspace; no setting removes it.
 * Sessions that must not use it get a PreToolUse hook that refuses every call.
 */
function refuseApplyPatch(reason: string): { matcher: string; hooks: Array<{ type: "command"; command: string }> } {
  const output = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
  // Codex runs command hooks through `sh -c`; the reasons here hold no single quotes.
  return { matcher: "apply_patch", hooks: [{ type: "command", command: `printf '%s' '${JSON.stringify(output)}'` }] };
}

/** Why apply_patch must be refused in this session, if it must. */
function applyPatchRefusal(options: SessionOptions): string | undefined {
  if (hashlineToolset(options).edit) return "apply_patch is disabled in this session. Edit files with the hashline read and edit tools.";
  const tools = options.tools;
  const editing = tools === undefined || tools === "default" || (Array.isArray(tools) && (tools.includes("edit") || tools.includes("write")));
  return editing ? undefined : "This session has no file editing tools.";
}

/**
 * codex-acp's default mode "agent" lets a reviewer model approve actions, so we
 * always switch to a user-reviewed one. Mode ids differ between adapter versions
 * (1.13.1's "read-only" is really workspace-write + ask), so match on `_meta.kind`.
 */
export function pickCodexMode(modes: acp.SessionMode[], policy: PermissionPolicy): string | undefined {
  const kind = (mode: acp.SessionMode) => (mode._meta as { kind?: string } | null | undefined)?.kind;
  if (policy === "full-access") return modes.find((mode) => kind(mode) === "full_access")?.id;
  const preferred = policy === "read-only" ? "read-only" : "workspace-write";
  const standard = modes.filter((mode) => kind(mode) === "standard");
  return (standard.find((mode) => mode.id === preferred) ?? standard[0])?.id;
}

function userCodexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

/** A CODEX_HOME without the user's config.toml, AGENTS.md or hooks, sharing their login. */
function isolatedCodexHome(): string {
  const home = join(homedir(), ".cache", "neoworks-harness", "codex-home");
  mkdirSync(home, { recursive: true });
  const auth = join(home, "auth.json");
  const userAuth = join(userCodexHome(), "auth.json");
  if (!existsSync(auth) && existsSync(userAuth)) symlinkSync(userAuth, auth);
  const config = join(home, "config.toml");
  if (!existsSync(config)) writeFileSync(config, "");
  return home;
}

/**
 * Codex via @agentclientprotocol/codex-acp. The adapter reads no session `_meta`
 * for config, only the CODEX_CONFIG env var, so every option is spawn-time and
 * each distinct config gets its own process (docs/research/codex-acp.md).
 */
export const codex: Driver = {
  id: "codex",
  efforts: ["low", "medium", "high", "xhigh"],
  capabilities: {
    systemPromptReplace: "process",
    systemPromptAppend: "process",
    // shell and web search can be switched off; apply_patch (edit/write) cannot.
    tools: "partial",
    model: "process",
    effort: "process",
    isolation: "process",
    // ask and auto-edit collapse into workspace-write.
    permissions: "partial",
    limits: "none",
    images: true,
    audio: false,
    resume: true,
    fork: true,
    cost: false,
  },

  async detect() {
    try {
      packageBin("@agentclientprotocol/codex-acp", "codex-acp");
    } catch (error) {
      return { available: false, detail: String(error) };
    }
    if (!existsSync(join(userCodexHome(), "auth.json")) && !process.env.OPENAI_API_KEY) {
      return { available: false, detail: "not logged in: run `codex login` or set OPENAI_API_KEY" };
    }
    return { available: true };
  },

  async spawn(options, context) {
    const { config, env } = codexConfig(options, context);
    // Otherwise an app MCP server sharing a name with one in the user's config is dropped.
    env.DISABLE_MCP_CONFIG_FILTERING = "true";
    if (options.isolation === "full") env.CODEX_HOME = isolatedCodexHome();
    if (Object.keys(config).length) env.CODEX_CONFIG = JSON.stringify(config);
    return nodeScript(packageBin("@agentclientprotocol/codex-acp", "codex-acp"), [], env);
  },

  mcpServers(options, context) {
    const hashline = hashlineToolset(options);
    return hashline.read || hashline.edit ? [hashlineMcpServer(context.cwd)] : [];
  },

  sessionMeta() {
    // Make session/new wait for MCP servers, so the app's tools exist on the first prompt.
    return { mcpStartupAwaitTimeoutMs: 15_000 };
  },

  async configure(agent, sessionId, modes, options) {
    const policy = options.permissions ?? "ask";
    const modeId = pickCodexMode(modes?.availableModes ?? [], policy);
    if (!modeId) throw new Error(`codex-acp offers no mode for permissions "${policy}"`);
    if (modes?.currentModeId !== modeId) await agent.request("session/set_mode", { sessionId, modeId });
  },
};

/** The `CODEX_CONFIG` overrides (config.toml keys) for one session's options. */
export function codexConfig(options: SessionOptions, context: DriverContext): { config: Record<string, unknown>; env: Record<string, string> } {
  const config: Record<string, unknown> = {};
  const env: Record<string, string> = {};
  const { replace, append } = options.systemPrompt ?? {};
  if (replace !== undefined) config.instructions = replace;
  if (append) config.developer_instructions = append;

  const tools = options.tools;
  if (tools !== undefined && tools !== "default") {
    // An explicit tool set is exhaustive: Codex extras outside our vocabulary go too.
    const allowed = (tool: BuiltinTool) => Array.isArray(tools) && tools.includes(tool);
    if (!allowed("shell")) merge(config, { features: { shell_tool: false } });
    if (!allowed("web_search")) config.web_search = "disabled";
    merge(config, FEATURES.subagents, FEATURES.images, { features: { goals: false } });
  }
  if (tools === "none") {
    // Pure completion: no sandbox or mode to explain, nothing to look at.
    merge(config, { include_permissions_instructions: false, include_collaboration_mode_instructions: false });
    merge(config, FEATURES.tool_search);
  }
  for (const feature of disabledFeatures(options)) merge(config, FEATURES[feature]);
  if (options.model) config.model = options.model;
  if (options.effort) config.model_reasoning_effort = EFFORT[options.effort];

  if (options.isolation === "full") {
    merge(config, FEATURES.skills, {
      project_doc_max_bytes: 0,
      features: { plugins: false, apps: false, recommended_plugins: false },
    });
  }

  const hooks: Record<string, unknown[]> = {};
  if (context.hooks?.hooks.length) {
    Object.assign(hooks, commandHooks(context.hooks.hooks, runnerCommand("codex", context.hooks.address)));
  }
  const refusal = applyPatchRefusal(options);
  if (refusal) hooks.PreToolUse = [...(hooks.PreToolUse ?? []), refuseApplyPatch(refusal)];
  if (Object.keys(hooks).length) {
    config.hooks = hooks;
    // Hooks outside the user's config need a trust hash per hook, or this switch.
    // It also runs untrusted hooks from `<cwd>/.codex/`; see docs/research/codex-acp.md.
    config.bypass_hook_trust = true;
  }
  return { config, env };
}

/** Deep-merge plain objects into `target`. */
function merge(target: Record<string, unknown>, ...sources: Record<string, unknown>[]): void {
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      const existing = target[key];
      if (isPlainObject(existing) && isPlainObject(value)) merge(existing, value);
      else target[key] = isPlainObject(value) ? structuredClone(value) : value;
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
