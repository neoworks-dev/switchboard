import type * as acp from "@agentclientprotocol/sdk";
import { nodeScript, siblingScript } from "../drivers/util.ts";
import type { SessionOptions } from "../options.ts";

/** MCP server name; Claude and Codex see its tools as `mcp__hashline__read` / `mcp__hashline__edit`. */
export const HASHLINE_SERVER = "hashline";

export const HASHLINE_PI_EXTENSION = siblingScript(import.meta.url, "./pi-extension");

const MCP_SERVER = siblingScript(import.meta.url, "./mcp-server");

/** The hashline MCP server for a session in `cwd`, as ACP passes MCP servers. */
export function hashlineMcpServer(cwd: string): acp.McpServerStdio {
  const { command, args, env = {} } = nodeScript(MCP_SERVER, [cwd]);
  return { name: HASHLINE_SERVER, command, args, env: Object.entries(env).map(([name, value]) => ({ name, value })) };
}

/**
 * Which hashline tools a session gets: they stand in for the harness's own
 * read and edit tools, so they follow `tools` and `permissions`.
 */
export function hashlineToolset(options: SessionOptions): { read: boolean; edit: boolean } {
  if (options.edits !== "hashline" || options.tools === "none") return { read: false, edit: false };
  const has = (tool: "read" | "edit") => !Array.isArray(options.tools) || options.tools.includes(tool);
  return { read: has("read"), edit: has("edit") && options.permissions !== "read-only" };
}
