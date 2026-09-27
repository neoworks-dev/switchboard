import { HASHLINE_SERVER, hashlineMcpServer, hashlineToolset } from "../hashline/index.ts";
import { commandHooks, runnerCommand } from "../hooks/command-hooks.ts";
import { disabledFeatures } from "../options.ts";
import type { BuiltinTool, Feature, PermissionPolicy, SessionOptions } from "../types.ts";
import type { Driver, DriverContext } from "./types.ts";
import { nodeScript, packageBin } from "./util.ts";

const TOOLS: Record<BuiltinTool, string[]> = {
  read: ["Read", "Glob", "Grep"],
  write: ["Write"],
  edit: ["Edit", "NotebookEdit"],
  shell: ["Bash"],
  web_search: ["WebSearch"],
  web_fetch: ["WebFetch"],
};

type Switch = { tools?: string[]; settings?: Record<string, unknown>; env?: Record<string, string> };

/** How to switch each feature off: tools to disallow, settings and env (Agent SDK 0.3 / CLI 2.1). */
const FEATURES: Record<Feature, Switch> = {
  subagents: { tools: ["Agent", "SendMessage", "ListAgents"] },
  workflows: { tools: ["Workflow"], settings: { disableWorkflows: true, workflowKeywordTriggerEnabled: false } },
  todos: { tools: ["TodoWrite", "TaskCreate", "TaskGet", "TaskUpdate", "TaskList"], settings: { todoFeatureEnabled: false } },
  scheduling: {
    tools: ["CronCreate", "CronDelete", "CronList", "ScheduleWakeup", "RemoteTrigger", "Monitor", "PushNotification", "ReadNotifications", "TaskStop"],
    env: { CLAUDE_CODE_DISABLE_CRON: "1", CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" },
  },
  worktrees: { tools: ["EnterWorktree", "ExitWorktree"] },
  plan_mode: { tools: ["EnterPlanMode", "ExitPlanMode"] },
  skills: { tools: ["Skill"], settings: { disableBundledSkills: true } },
  memory: { settings: { autoMemoryEnabled: false } },
  // Loads MCP tool schemas up front instead of behind a search round trip.
  tool_search: { tools: ["ToolSearch"], env: { ENABLE_TOOL_SEARCH: "false" } },
  images: {},
  user_questions: { tools: ["AskUserQuestion"] },
};

const MODES: Record<PermissionPolicy, string> = {
  ask: "default",
  "auto-edit": "acceptEdits",
  "read-only": "plan",
  "full-access": "bypassPermissions",
};

/**
 * Claude Code via claude-agent-acp. Everything is per session: the adapter
 * spreads `_meta.claudeCode.options` into the Agent SDK's `Options`
 * (docs/research/claude-agent-acp.md), so one process serves every config.
 */
export const claude: Driver = {
  id: "claude",
  efforts: ["low", "medium", "high", "xhigh", "max", "ultracode"],
  capabilities: {
    systemPromptReplace: "session",
    systemPromptAppend: "session",
    tools: "session",
    model: "session",
    effort: "session",
    // settingSources: [] still leaves the adapter reading ~/.claude/settings.json for defaults.
    isolation: "partial",
    permissions: "session",
    limits: "session",
    images: true,
    audio: false,
    resume: true,
    fork: true,
    cost: true,
  },

  async detect() {
    try {
      packageBin("@agentclientprotocol/claude-agent-acp", "claude-agent-acp");
      return { available: true };
    } catch (error) {
      return { available: false, detail: String(error) };
    }
  },

  async spawn() {
    return nodeScript(packageBin("@agentclientprotocol/claude-agent-acp", "claude-agent-acp"));
  },

  sessionMeta(options, context) {
    const sdk = claudeOptions(options, context);
    return Object.keys(sdk).length ? { claudeCode: { options: sdk } } : undefined;
  },

  mcpServers(options, context) {
    const hashline = hashlineToolset(options);
    return hashline.read || hashline.edit ? [hashlineMcpServer(context.cwd)] : [];
  },

  async configure(agent, sessionId, modes, options) {
    // The adapter ignores permissionMode in _meta; the initial mode comes from settings.
    if (!options.permissions) return;
    const modeId = MODES[options.permissions];
    if (!modes?.availableModes.some((mode) => mode.id === modeId)) {
      throw new Error(`claude-agent-acp offers no "${modeId}" mode for permissions "${options.permissions}"`);
    }
    if (modes.currentModeId !== modeId) await agent.request("session/set_mode", { sessionId, modeId });
  },
};

/** Agent SDK `Options` for one session, sent as `_meta.claudeCode.options`. */
export function claudeOptions(options: SessionOptions, context: DriverContext): Record<string, unknown> {
  const sdk: Record<string, unknown> = {};
  const settings: Record<string, unknown> = {};
  const env: Record<string, string> = {};
  const disallowed: string[] = [];
  const allowed: string[] = [];

  const { replace, append } = options.systemPrompt ?? {};
  if (replace !== undefined) {
    sdk.systemPrompt = append ? `${replace}\n\n${append}` : replace;
  } else if (append) {
    sdk.systemPrompt = { type: "preset", preset: "claude_code", append };
  }
  if (options.tools === "none") sdk.tools = [];
  else if (Array.isArray(options.tools)) sdk.tools = options.tools.flatMap((tool) => TOOLS[tool]);
  if (options.model) sdk.model = options.model;
  if (options.effort === "ultracode") {
    sdk.effort = "xhigh";
    settings.ultracode = true;
  } else if (options.effort) {
    sdk.effort = options.effort;
  }

  for (const feature of disabledFeatures(options)) {
    const off = FEATURES[feature];
    disallowed.push(...(off.tools ?? []));
    Object.assign(settings, off.settings);
    Object.assign(env, off.env);
  }

  const hashline = hashlineToolset(options);
  if (hashline.read || hashline.edit) {
    // The hashline tools stand in for Read and Edit. Reading never asks, as with
    // Read; editing asks unless the policy already accepts edits.
    disallowed.push("Read", "Edit");
    if (hashline.read) allowed.push(`mcp__${HASHLINE_SERVER}__read`);
    if (hashline.edit && options.permissions === "auto-edit") allowed.push(`mcp__${HASHLINE_SERVER}__edit`);
    if (!hashline.edit) disallowed.push(`mcp__${HASHLINE_SERVER}__edit`);
  }

  if (context.hooks?.hooks.length) settings.hooks = commandHooks(context.hooks.hooks, runnerCommand("claude", context.hooks.address));

  if (options.isolation === "full") {
    sdk.settingSources = [];
    sdk.strictMcpConfig = true;
  }
  if (options.limits?.maxTurns) sdk.maxTurns = options.limits.maxTurns;
  if (options.limits?.maxBudgetUsd) sdk.maxBudgetUsd = options.limits.maxBudgetUsd;
  if (disallowed.length) sdk.disallowedTools = disallowed;
  if (allowed.length) sdk.allowedTools = allowed;
  // Flag settings load even with settingSources: [], and so do hooks placed here.
  if (Object.keys(settings).length) sdk.settings = settings;
  if (Object.keys(env).length) sdk.env = env;
  return sdk;
}
