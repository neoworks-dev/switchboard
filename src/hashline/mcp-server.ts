#!/usr/bin/env node
/**
 * Stdio MCP server exposing the hashline `read` and `edit` tools:
 * `mcp-server.ts <cwd>`. Relative paths resolve against `<cwd>`.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { HASHLINE_SERVER } from "./index.ts";
import { hashlineTools } from "./tools.ts";

const cwd = process.argv[2] ?? process.cwd();
const tools = hashlineTools({ read: "read", edit: "edit" });

const server = new Server({ name: HASHLINE_SERVER, version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: tools.map(({ name, description, inputSchema, annotations }) => ({
    name,
    description,
    inputSchema: inputSchema as { type: "object" },
    annotations,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  const tool = tools.find((candidate) => candidate.name === params.name);
  if (!tool) return { content: [{ type: "text", text: `Unknown tool ${params.name}` }], isError: true };
  const { text, isError } = await tool.run(params.arguments ?? {}, cwd).catch((error: Error) => ({ text: error.message, isError: true }));
  return { content: [{ type: "text", text }], isError };
});

await server.connect(new StdioServerTransport());
