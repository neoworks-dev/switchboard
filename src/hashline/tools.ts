/**
 * Hashline read and edit tools, harness-neutral: a JSON Schema, a description
 * and a `run` over a working directory. Served over MCP to Claude and Codex
 * (mcp-server.ts) and registered natively in pi (pi-extension.ts).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { applyEdits, StaleAnchorError, type HashlineEdit } from "./apply.ts";
import { formatLines, parseAnchor } from "./hash.ts";

export type ToolResult = { text: string; isError?: boolean };

export type HashlineTool = {
  name: "read" | "edit";
  description: string;
  inputSchema: Record<string, unknown>;
  /** MCP tool annotations; harnesses use them to decide what needs approval. */
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean };
  run(input: Record<string, unknown>, cwd: string): Promise<ToolResult>;
};

const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;
/** Identical no-op edits in a row before telling the model to stop and re-read. */
const NOOP_LIMIT = 3;

export function hashlineTools(names: { read: string; edit: string }): HashlineTool[] {
  const noops = new Map<string, { payload: string; count: number }>();

  const read: HashlineTool = {
    name: "read",
    description:
      `Read a text file. Each line comes back as LINE#ID:text, e.g. \`5#ZP:  const x = 1;\`. ` +
      `Pass the LINE#ID tags to ${names.edit} to change lines. Shows at most ${MAX_LINES} lines or 50KB; use offset and limit for more.`,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, absolute or relative to the working directory." },
        offset: { type: "integer", minimum: 1, description: "First line to show (1-based)." },
        limit: { type: "integer", minimum: 1, description: "Number of lines to show." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    async run(input, cwd) {
      const path = String(input.path);
      const all = (await readFile(resolve(cwd, path), "utf8")).split("\n");
      const first = typeof input.offset === "number" ? Math.max(1, input.offset) : 1;
      const limit = typeof input.limit === "number" ? input.limit : MAX_LINES;
      const shown = fitBytes(all.slice(first - 1, first - 1 + Math.min(limit, MAX_LINES)), first);
      const last = first + shown.count - 1;
      const note = first > 1 || last < all.length ? `\n\n[Lines ${first}-${last} of ${all.length}.]` : "";
      return { text: shown.text + note };
    },
  };

  const edit: HashlineTool = {
    name: "edit",
    description: [
      `Edit a file by LINE#ID tags from ${names.read}. All edits in one call refer to the file as last read and are checked before anything is written; if the file changed, the call fails and shows fresh tags.`,
      "Ops: replace (line pos, or range pos..end inclusive; lines [] deletes), append (after pos, or at end of file), prepend (before pos, or at start of file). Missing files are created by append/prepend without pos.",
      "Put every change to a file in one call; tags are stale after it. Replace a whole construct rather than patching around its closing line: either only the body, or header through closer. Copy indentation exactly.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, absolute or relative to the working directory." },
        edits: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              op: { type: "string", enum: ["replace", "append", "prepend"] },
              pos: { type: "string", description: 'Anchor "LINE#ID". Required for replace.' },
              end: { type: "string", description: 'Last line of a replace range, "LINE#ID".' },
              lines: { type: "array", items: { type: "string" }, description: "New lines, without trailing newlines." },
              current: { type: "string", description: "Single-line replace: the line's current text, as a check." },
            },
            required: ["op", "lines"],
            additionalProperties: false,
          },
        },
      },
      required: ["path", "edits"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    async run(input, cwd) {
      const path = resolve(cwd, String(input.path));
      const payload = JSON.stringify(input.edits);
      let edits: HashlineEdit[];
      try {
        edits = (input.edits as RawEdit[]).map(parseEdit);
      } catch (error) {
        return { text: `Invalid edit: ${(error as Error).message}`, isError: true };
      }

      const existing = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" && edits.every((edit) => edit.op !== "replace" && !edit.pos)) return undefined;
        throw error;
      });
      let result;
      try {
        result = applyEdits((existing ?? "").split("\n"), edits);
      } catch (error) {
        return { text: error instanceof StaleAnchorError ? error.message : `Edit failed: ${(error as Error).message}`, isError: true };
      }

      if (!result.changed) {
        const previous = noops.get(path);
        const count = previous?.payload === payload ? previous.count + 1 : 1;
        noops.set(path, { payload, count });
        if (count >= NOOP_LIMIT) {
          return { text: `STOP: this edit changed nothing ${count} times in a row. Re-read ${input.path} before editing it again.`, isError: true };
        }
        return { text: "No changes: the file already has this content." };
      }
      noops.delete(path);
      if (existing === undefined) await mkdir(dirname(path), { recursive: true });
      await writeFile(path, result.lines.join("\n"));
      const verb = existing === undefined ? "Created" : "Edited";
      return { text: [`${verb} ${input.path}.`, ...result.warnings.map((warning) => `Note: ${warning}`)].join("\n") };
    },
  };

  return [read, edit];
}

type RawEdit = { op: string; pos?: string; end?: string; lines?: string[] | null; current?: string };

function parseEdit(raw: RawEdit): HashlineEdit {
  const lines = raw.lines ?? [];
  const pos = raw.pos ? parseAnchor(raw.pos) : undefined;
  switch (raw.op) {
    case "replace":
      if (!pos) throw new Error('replace needs "pos"');
      return { op: "replace", pos, end: raw.end ? parseAnchor(raw.end) : undefined, lines, current: raw.current };
    case "append":
    case "prepend":
      return { op: raw.op, pos, lines };
    default:
      throw new Error(`unknown op "${raw.op}"`);
  }
}

/** Formatted lines, cut to fit MAX_BYTES. */
function fitBytes(lines: readonly string[], first: number): { text: string; count: number } {
  const out: string[] = [];
  let bytes = 0;
  for (const [i, line] of lines.entries()) {
    const formatted = formatLines([line], first + i);
    bytes += Buffer.byteLength(formatted) + 1;
    if (bytes > MAX_BYTES && out.length) break;
    out.push(formatted);
  }
  return { text: out.join("\n"), count: out.length };
}
