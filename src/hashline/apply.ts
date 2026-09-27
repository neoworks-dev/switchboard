/**
 * Applying hashline edits. Every anchor is checked against the file before
 * anything changes; edits then apply bottom-up, so all anchors refer to the
 * file as it was read. Derived from oh-my-pi / @the-agency/pi-hashline-edit (MIT),
 * see hash.ts.
 */
import { formatAnchor, lineId, type Anchor } from "./hash.ts";

export type HashlineEdit =
  /** Replace line `pos`, or `pos` through `end`, with `lines` (empty deletes). */
  | { op: "replace"; pos: Anchor; end?: Anchor; lines: string[]; current?: string }
  /** Insert `lines` after `pos`, or at the end of the file. */
  | { op: "append"; pos?: Anchor; lines: string[] }
  /** Insert `lines` before `pos`, or at the start of the file. */
  | { op: "prepend"; pos?: Anchor; lines: string[] };

export type ApplyResult = { lines: string[]; changed: boolean; warnings: string[] };

const MISMATCH_CONTEXT = 2;

/** Thrown when anchors no longer match the file; the message shows fresh anchors. */
export class StaleAnchorError extends Error {
  constructor(stale: readonly number[], lines: readonly string[]) {
    super(describeStale(stale, lines));
    this.name = "StaleAnchorError";
  }
}

export function applyEdits(original: readonly string[], edits: readonly HashlineEdit[]): ApplyResult {
  const warnings: string[] = [];
  validate(original, edits);

  const unique = dedupe(edits.map(fixEscapedTabs(warnings)));
  assertNoOverlap(unique);

  const lines = [...original];
  let changed = false;
  for (const edit of bottomUp(unique, original.length)) {
    if (edit.op === "replace") {
      const start = edit.pos.line - 1;
      const count = (edit.end?.line ?? edit.pos.line) - edit.pos.line + 1;
      const replacement = edit.end ? stripBoundaryEchoes(original, edit, warnings) : edit.lines;
      if (sameLines(original.slice(start, start + count), replacement)) continue;
      lines.splice(start, count, ...replacement);
    } else {
      if (edit.lines.length === 0) continue;
      const empty = lines.length === 1 && lines[0] === "";
      const at = edit.op === "append" ? (edit.pos?.line ?? lines.length) : (edit.pos?.line ?? 1) - 1;
      // Inserting into an empty file replaces its single empty line.
      if (empty && !edit.pos) lines.splice(0, 1, ...edit.lines);
      else lines.splice(at, 0, ...edit.lines);
    }
    changed = true;
  }
  return { lines, changed, warnings };
}

function validate(lines: readonly string[], edits: readonly HashlineEdit[]): void {
  const stale = new Set<number>();
  const check = (anchor: Anchor | undefined) => {
    if (!anchor) return;
    if (anchor.line > lines.length) throw new Error(`Line ${anchor.line} does not exist (file has ${lines.length} lines).`);
    if (lineId(anchor.line, lines[anchor.line - 1]!) !== anchor.id) stale.add(anchor.line);
  };
  for (const edit of edits) {
    check(edit.pos);
    if (edit.op === "replace") {
      check(edit.end);
      if (edit.end && edit.end.line < edit.pos.line) {
        throw new Error(`Range ${edit.pos.line}..${edit.end.line} ends before it starts.`);
      }
    }
  }
  if (stale.size) throw new StaleAnchorError([...stale].sort((a, b) => a - b), lines);

  const wrong = edits.flatMap((edit) =>
    edit.op === "replace" && !edit.end && edit.current !== undefined && lines[edit.pos.line - 1] !== edit.current
      ? [`line ${edit.pos.line} is ${JSON.stringify(lines[edit.pos.line - 1])}, not ${JSON.stringify(edit.current)}`]
      : [],
  );
  if (wrong.length) throw new Error(`"current" does not match the file:\n  ${wrong.join("\n  ")}`);
}

/** Models sometimes write `\\t` for tab indentation; turn leading ones into real tabs. */
function fixEscapedTabs(warnings: string[]): (edit: HashlineEdit) => HashlineEdit {
  return (edit) => {
    if (edit.lines.some((line) => line.includes("\t")) || !edit.lines.some((line) => line.startsWith("\\t"))) return edit;
    warnings.push("Converted leading \\t escapes to real tabs.");
    return { ...edit, lines: edit.lines.map((line) => line.replace(/^(?:\\t)+/, (escaped) => "\t".repeat(escaped.length / 2))) };
  };
}

function dedupe(edits: HashlineEdit[]): HashlineEdit[] {
  const seen = new Set<string>();
  return edits.filter((edit) => {
    const key = JSON.stringify([edit.op, edit.pos?.line, edit.op === "replace" ? edit.end?.line : undefined, edit.lines]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function assertNoOverlap(edits: readonly HashlineEdit[]): void {
  const ranges = edits
    .filter((edit): edit is Extract<HashlineEdit, { op: "replace" }> => edit.op === "replace")
    .map((edit) => [edit.pos.line, edit.end?.line ?? edit.pos.line] as const)
    .sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) {
    const [start, end] = ranges[i]!;
    const [prevStart, prevEnd] = ranges[i - 1]!;
    if (start <= prevEnd) throw new Error(`Replace ranges ${prevStart}..${prevEnd} and ${start}..${end} overlap; merge them into one edit.`);
  }
}

/** Last line first; on the same line replace, then append, then prepend. */
function bottomUp(edits: readonly HashlineEdit[], lineCount: number): HashlineEdit[] {
  const position = (edit: HashlineEdit): [number, number] => {
    if (edit.op === "replace") return [edit.end?.line ?? edit.pos.line, 0];
    if (edit.op === "append") return [edit.pos?.line ?? lineCount + 1, 1];
    return [edit.pos?.line ?? 0, 2];
  };
  return edits
    .map((edit, index) => ({ edit, index, at: position(edit) }))
    .sort((a, b) => b.at[0] - a.at[0] || a.at[1] - b.at[1] || a.index - b.index)
    .map(({ edit }) => edit);
}

/**
 * A range replace sometimes repeats the unchanged lines just above or below
 * the range. Drop such echoes, keeping at least one replacement line.
 */
function stripBoundaryEchoes(original: readonly string[], edit: Extract<HashlineEdit, { op: "replace" }>, warnings: string[]): string[] {
  const lines = edit.lines;
  const end = edit.end!.line;
  const matches = (payloadStart: number, fileStart: number, n: number) => {
    let content = false;
    for (let i = 0; i < n; i++) {
      const payload = lines[payloadStart + i]?.trimEnd();
      if (payload !== original[fileStart + i]?.trimEnd()) return false;
      if (payload) content = true;
    }
    return content;
  };
  const longest = (max: number, test: (n: number) => boolean) => {
    for (let n = max; n >= 1; n--) if (test(n)) return n;
    return 0;
  };
  let lead = longest(Math.min(lines.length, edit.pos.line - 1), (n) => matches(0, edit.pos.line - 1 - n, n));
  let trail = longest(Math.min(lines.length, original.length - end), (n) => matches(lines.length - n, end, n));
  while (lead + trail > 0 && lines.length - lead - trail < 1) {
    if (trail >= lead) trail--;
    else lead--;
  }
  if (!lead && !trail) return lines;
  warnings.push(`Dropped ${lead + trail} line(s) repeating the unchanged lines around ${edit.pos.line}..${end}.`);
  return lines.slice(lead, lines.length - trail);
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

function describeStale(stale: readonly number[], lines: readonly string[]): string {
  const shown = new Set<number>();
  for (const line of stale) {
    for (let n = Math.max(1, line - MISMATCH_CONTEXT); n <= Math.min(lines.length, line + MISMATCH_CONTEXT); n++) shown.add(n);
  }
  const out = [
    `${stale.length} line${stale.length > 1 ? "s have" : " has"} changed since the last read. Use the updated LINE#ID references below (>>> marks changed lines).`,
    "",
  ];
  let previous = 0;
  for (const n of [...shown].sort((a, b) => a - b)) {
    if (previous && n > previous + 1) out.push("    ...");
    previous = n;
    out.push(`${stale.includes(n) ? ">>> " : "    "}${formatAnchor(n, lines[n - 1]!)}:${lines[n - 1]}`);
  }
  return out.join("\n");
}
