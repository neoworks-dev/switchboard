import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import type { HookBridge } from "../../drivers/types.ts";
import { siblingScript } from "../../drivers/util.ts";
import { HASHLINE_PI_EXTENSION, hashlineToolset } from "../../hashline/index.ts";
import type { BuiltinTool, Effort, SessionOptions } from "../../types.ts";
import { HOOK_SOCKET_ENV, HOOKS_ENV, PERMISSION_POLICY_ENV, READ_ONLY_TOOLS } from "./bridge.ts";
import type { ThinkingLevel } from "./protocol.ts";

export type Launch = { args: string[]; env: Record<string, string> };

export type LaunchContext = {
  /** Resume this pi session id instead of starting a new one. */
  resume?: string;
  /** pi-mcp-adapter config file, when the session has MCP servers. */
  mcpConfigPath?: string;
  /** Explicit path to load pi-mcp-adapter from, when it isn't already an active package. */
  mcpAdapterPath?: string;
  /** PI_CODING_AGENT_DIR for `isolation: "full"`. */
  isolatedAgentDir?: string;
  hooks?: HookBridge;
};

const TOOLS: Record<BuiltinTool, string[]> = {
  read: ["read", "grep", "find", "ls"],
  write: ["write"],
  edit: ["edit"],
  shell: ["bash"],
  // pi ships no web tools.
  web_search: [],
  web_fetch: [],
};

const THINKING: Record<Effort, ThinkingLevel> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
  // pi has no orchestration mode.
  ultracode: "xhigh",
};

export const EXTENSION_PATH = siblingScript(import.meta.url, "./extension");

/** Flags and env for `pi --mode rpc` that realize one session's options. Pure. */
export function buildLaunch(options: SessionOptions, context: LaunchContext = {}): Launch {
  const args: string[] = [];
  const env: Record<string, string> = { PI_SKIP_VERSION_CHECK: "1" };

  if (context.resume) args.push("--session", context.resume);

  const { replace, append } = options.systemPrompt ?? {};
  if (replace !== undefined) args.push("--system-prompt", replace);
  if (append) args.push("--append-system-prompt", append);

  const hashline = hashlineToolset(options);
  const tools = selectTools(options, hashline);
  if (tools?.length === 0) args.push("--no-tools");
  else if (tools) args.push("--tools", tools.join(","));

  if (options.model) args.push("--model", options.model);
  if (options.effort) args.push("--thinking", THINKING[options.effort]);

  if (options.isolation === "full" && context.isolatedAgentDir) {
    env.PI_CODING_AGENT_DIR = context.isolatedAgentDir;
    args.push("--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes", "--no-approve");
  }

  const policy = options.permissions ?? "ask";
  const bridged = policy === "ask" || policy === "auto-edit";
  const hooks = context.hooks?.hooks ?? [];
  if (bridged) env[PERMISSION_POLICY_ENV] = policy;
  if (hooks.length && context.hooks) {
    env[HOOK_SOCKET_ENV] = context.hooks.address;
    env[HOOKS_ENV] = hooks.join(",");
  }
  if (bridged || hooks.length) args.push("--extension", EXTENSION_PATH);

  if (hashline.read || hashline.edit) args.push("--extension", HASHLINE_PI_EXTENSION);

  if (context.mcpAdapterPath) args.push("--extension", context.mcpAdapterPath);
  if (context.mcpConfigPath) args.push("--mcp-config", context.mcpConfigPath);

  return { args, env };
}

/**
 * pi tool allowlist, or undefined for pi's defaults. `read-only` permissions
 * narrow it. The allowlist covers extension tools too, so hashline's go in.
 */
function selectTools(options: SessionOptions, hashline: { read: boolean; edit: boolean }): string[] | undefined {
  const requested = options.tools;
  let tools =
    requested === "none" ? [] : Array.isArray(requested) ? requested.flatMap((tool) => TOOLS[tool]) : undefined;
  if (options.permissions === "read-only") tools = (tools ?? TOOLS.read).filter((tool) => READ_ONLY_TOOLS.has(tool));
  if (tools && hashline.read) tools.push("hashline_read");
  if (tools && hashline.edit) tools.push("hashline_edit");
  return tools && [...new Set(tools)];
}

export function userAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

/**
 * An agent dir without the user's extensions, skills, context files or MCP
 * config, sharing their login and default model. pi writes `auth.json` in
 * place, so token refreshes flow back through the symlink.
 */
export function prepareIsolatedAgentDir(): string {
  const source = userAgentDir();
  const dir = join(homedir(), ".cache", "neoworks-harness", "pi-agent");
  mkdirSync(dir, { recursive: true });
  for (const file of ["auth.json", "models.json"]) {
    if (existsSync(join(source, file)) && !existsSync(join(dir, file))) symlinkSync(join(source, file), join(dir, file));
  }
  const settings = readJson<Record<string, unknown>>(join(source, "settings.json")) ?? {};
  const defaults = Object.fromEntries(
    ["defaultProvider", "defaultModel", "defaultThinkingLevel"].filter((key) => key in settings).map((key) => [key, settings[key]]),
  );
  writeFileSync(join(dir, "settings.json"), `${JSON.stringify(defaults, null, 2)}\n`);
  return dir;
}

/** Where the user's pi-mcp-adapter package lives, if installed. */
export function findMcpAdapter(): { path: string; activePackage: boolean } | undefined {
  const dir = userAgentDir();
  const path = join(dir, "npm", "node_modules", "pi-mcp-adapter", "index.ts");
  if (!existsSync(path)) return undefined;
  const packages = readJson<{ packages?: unknown[] }>(join(dir, "settings.json"))?.packages ?? [];
  return { path, activePackage: packages.some((entry) => JSON.stringify(entry).includes("pi-mcp-adapter")) };
}

/** Write ACP MCP servers as a pi-mcp-adapter config; tools are exposed directly, not via its proxy tool. */
export function writeMcpConfig(servers: acp.McpServer[]): string {
  const mcpServers = Object.fromEntries(servers.map((server) => [server.name, toPiMcpServer(server)]));
  const path = join(mkdtempSync(join(tmpdir(), "neoworks-pi-mcp-")), "mcp.json");
  writeFileSync(path, JSON.stringify({ mcpServers }, null, 2));
  return path;
}

function toPiMcpServer(server: acp.McpServer): Record<string, unknown> {
  const common = { directTools: true, lifecycle: "eager" };
  if ("type" in server && server.type === "http") {
    return { ...common, url: server.url, headers: pairs(server.headers) };
  }
  if ("type" in server) throw new Error(`pi-mcp-adapter cannot connect to ${server.type} MCP server "${server.name}"`);
  return { ...common, command: server.command, args: server.args, env: pairs(server.env) };
}

function pairs(list: Array<{ name: string; value: string }>): Record<string, string> {
  return Object.fromEntries(list.map(({ name, value }) => [name, value]));
}

function readJson<T>(path: string): T | undefined {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : undefined;
}
