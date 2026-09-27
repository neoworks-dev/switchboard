#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { Command, InvalidArgumentError, Option } from "commander";
import { createHarness } from "../core/harness.ts";
import { rejectPermission } from "../core/session.ts";
import type { Hooks } from "../hooks/types.ts";
import { serve } from "../server/serve.ts";
import {
  BUILTIN_TOOLS,
  EDIT_MODES,
  EFFORTS,
  FEATURES,
  HARNESS_IDS,
  ISOLATION_LEVELS,
  PERMISSION_POLICIES,
  sessionOptionsSchema,
  type HarnessId,
  type SessionOptions,
} from "../options.ts";
import { approveAll, askOnTerminal, printEvent } from "./terminal.ts";

type RunFlags = {
  harness?: HarnessId;
  cwd: string;
  resume?: string;
  system?: string;
  append?: string;
  tools?: SessionOptions["tools"];
  model?: string;
  effort?: SessionOptions["effort"];
  isolation?: SessionOptions["isolation"];
  permissions?: SessionOptions["permissions"];
  disable?: SessionOptions["disable"];
  edits?: SessionOptions["edits"];
  mcp: acp.McpServer[];
  image: string[];
  yes?: boolean;
  traceHooks?: boolean;
  blockTool: string[];
};

const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };

const program = new Command("neoworks-harness")
  .description("Drive Claude Code, Codex and pi through one ACP-based backend")
  .showHelpAfterError();

program
  .command("detect")
  .description("list harnesses and whether they are usable here")
  .action(async () => {
    const harness = await createHarness();
    for (const [id, detection] of Object.entries(await harness.detect())) {
      console.log(`${detection?.available ? "✓" : "✗"} ${id}${detection?.detail ? `  ${detection.detail}` : ""}`);
    }
  });

program
  .command("serve")
  .description("serve the harnesses over ACP on a WebSocket, for HarnessClient")
  .option("--host <host>", "interface to listen on", "127.0.0.1")
  .option("--port <port>", "0 picks a free one", (value) => Number.parseInt(value, 10), 0)
  .action(async ({ host, port }: { host: string; port: number }) => {
    // The parent passes the token through env so it never shows up in `ps`.
    const token = process.env.NEOWORKS_HARNESS_TOKEN;
    const sidecar = await serve({ harness: await createHarness(), host, port, token });
    console.log(`listening on ${sidecar.url}`);
    if (!token) console.error(`token ${sidecar.token}`);
    const stop = () => void sidecar.close().then(() => process.exit(0));
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });

program
  .command("run")
  .description("run one prompt turn and stream the result")
  .argument("<prompt...>", "prompt text")
  .addOption(new Option("--harness <id>", "harness to use (default: config, else claude)").choices(HARNESS_IDS))
  .option("--cwd <dir>", "working directory of the session", process.cwd())
  .option("--resume <sessionId>", "continue an earlier session instead of starting one")
  .option("--system <text>", "replace the harness system prompt")
  .option("--append <text>", "append to the harness system prompt")
  .option("--tools <list>", `default | none | comma list of ${BUILTIN_TOOLS.join(",")}`, parseTools)
  .option("--model <id>", "model id as the harness names it")
  .addOption(new Option("--effort <level>", "reasoning effort").choices(EFFORTS))
  .addOption(new Option("--isolation <level>", "full ignores your own harness config").choices(ISOLATION_LEVELS))
  .addOption(new Option("--permissions <policy>", "tool approval policy").choices(PERMISSION_POLICIES))
  .option("--disable <list>", `all | comma list of ${FEATURES.join(",")}`, parseDisable)
  .addOption(new Option("--edits <mode>", "file editing tools").choices(EDIT_MODES))
  .option("--mcp <name=url>", "add an http MCP server (repeatable)", collectMcp, [])
  .option("--image <path>", "attach an image (repeatable)", collect, [])
  .option("-y, --yes", "approve every permission request")
  .option("--trace-hooks", "print every hook call to stderr")
  .option("--block-tool <name>", "refuse this tool through a beforeToolUse hook (repeatable)", collect, [])
  .action(async (words: string[], flags: RunFlags) => run(words.join(" "), flags));

async function run(text: string, flags: RunFlags): Promise<void> {
  const harness = await createHarness();
  try {
    const init = {
      harness: flags.harness,
      cwd: flags.cwd,
      mcpServers: flags.mcp,
      options: toSessionOptions(flags),
      onPermission: flags.yes ? approveAll : process.stdin.isTTY ? askOnTerminal : rejectPermission,
      hooks: cliHooks(flags),
    };
    const session = flags.resume ? await harness.resumeSession(flags.resume, init) : await harness.createSession(init);
    console.error(`[${session.harness} session ${session.id}]`);

    const prompt: acp.ContentBlock[] = [{ type: "text", text }];
    for (const path of flags.image) prompt.push(await imageBlock(path));
    for await (const event of session.prompt(prompt)) printEvent(event);
    await session.close();
  } finally {
    await harness.close();
  }
}

function toSessionOptions(flags: RunFlags): SessionOptions {
  const systemPrompt = flags.system !== undefined || flags.append !== undefined ? { replace: flags.system, append: flags.append } : undefined;
  return sessionOptionsSchema.parse({
    systemPrompt,
    tools: flags.tools,
    model: flags.model,
    effort: flags.effort,
    isolation: flags.isolation,
    permissions: flags.permissions,
    disable: flags.disable,
    edits: flags.edits,
  });
}

/** Hooks for trying the hook bridge from a terminal. */
function cliHooks({ traceHooks, blockTool }: RunFlags): Hooks | undefined {
  if (!traceHooks && blockTool.length === 0) return undefined;
  const trace = (hook: string, event: object) => {
    if (traceHooks) console.error(`[hook ${hook}] ${JSON.stringify(event).slice(0, 300)}`);
  };
  const hooks: Hooks = {
    beforeToolUse: (event) => {
      trace("beforeToolUse", event);
      if (blockTool.includes(event.toolName)) return { block: `${event.toolName} is blocked by --block-tool.` };
    },
  };
  if (traceHooks) {
    hooks.afterToolUse = (event) => void trace("afterToolUse", event);
    hooks.onPromptSubmit = (event) => void trace("onPromptSubmit", event);
    hooks.onStop = (event) => void trace("onStop", event);
  }
  return hooks;
}

async function imageBlock(path: string): Promise<acp.ContentBlock> {
  const mimeType = IMAGE_TYPES[extname(path).toLowerCase()];
  if (!mimeType) throw new Error(`unsupported image type: ${path}`);
  return { type: "image", mimeType, data: (await readFile(path)).toString("base64") };
}

function parseTools(value: string): SessionOptions["tools"] {
  const parsed = sessionOptionsSchema.shape.tools.safeParse(value === "default" || value === "none" ? value : value.split(","));
  if (!parsed.success) throw new InvalidArgumentError(`expected default, none or a list of ${BUILTIN_TOOLS.join(", ")}`);
  return parsed.data;
}

function parseDisable(value: string): SessionOptions["disable"] {
  const parsed = sessionOptionsSchema.shape.disable.safeParse(value === "all" ? value : value.split(","));
  if (!parsed.success) throw new InvalidArgumentError(`expected all or a list of ${FEATURES.join(", ")}`);
  return parsed.data;
}

function collectMcp(value: string, previous: acp.McpServer[]): acp.McpServer[] {
  const [name, url] = value.split(/=(.*)/s);
  if (!name || !url) throw new InvalidArgumentError("expected name=url");
  return [...previous, { type: "http", name, url, headers: [] }];
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

try {
  // Always Node-style argv: under ELECTRON_RUN_AS_NODE, commander's auto-detection sees
  // Electron and would treat this script's path as the first argument.
  await program.parseAsync(process.argv, { from: "node" });
} catch (error) {
  console.error(`error: ${describeError(error)}`);
  process.exitCode = 1;
}

/** JSON-RPC errors from an agent carry the useful part in `data`. */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const data = (error as { data?: unknown }).data;
  return data === undefined ? error.message : `${error.message} ${JSON.stringify(data)}`;
}
