/**
 * pi extension, loaded with `-e`, that swaps pi's `read` and `edit` tools for
 * `hashline_read` and `hashline_edit`.
 */
import { hashlineTools, type ToolResult } from "./tools.ts";

const NAMES = { read: "hashline_read", edit: "hashline_edit" } as const;

// Minimal structural slice of pi's ExtensionAPI, so this file needs no pi dependency.
type PiToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean; details: undefined };
type ExtensionAPI = {
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: Record<string, unknown>;
    execute(toolCallId: string, params: Record<string, unknown>, signal: unknown, onUpdate: unknown, ctx: { cwd: string }): Promise<PiToolResult>;
  }): void;
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
  on(event: "session_start", handler: () => void): void;
};

export default function hashline(pi: ExtensionAPI): void {
  for (const tool of hashlineTools(NAMES)) {
    pi.registerTool({
      name: NAMES[tool.name],
      label: `Hashline ${tool.name}`,
      description: tool.description,
      // pi validates plain JSON Schema as well as TypeBox.
      parameters: tool.inputSchema,
      execute: async (_id, params, _signal, _onUpdate, ctx) =>
        toPi(await tool.run(params, ctx.cwd).catch((error: Error) => ({ text: error.message, isError: true }))),
    });
  }

  // Follow the session's tool set, so --tools and read-only still decide what is on.
  pi.on("session_start", () => {
    const active = pi.getActiveTools();
    const swapped = { read: NAMES.read, edit: NAMES.edit } as Record<string, string>;
    const others = active.filter((name) => !(name in swapped) && name !== NAMES.read && name !== NAMES.edit);
    pi.setActiveTools([...others, ...active.flatMap((name) => swapped[name] ?? [])]);
  });
}

function toPi({ text, isError }: ToolResult): PiToolResult {
  return { content: [{ type: "text", text }], isError, details: undefined };
}
