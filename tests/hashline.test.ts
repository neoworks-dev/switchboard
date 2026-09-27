import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEdits, StaleAnchorError } from "../src/hashline/apply.ts";
import { formatAnchor, formatLines, lineId, parseAnchor, xxHash32 } from "../src/hashline/hash.ts";
import { hashlineTools } from "../src/hashline/tools.ts";

const FILE = ["function alpha() {", "\tlog();", "}", "", "function beta() {", "\treturn 1;", "}"];
const at = (line: number) => parseAnchor(formatAnchor(line, FILE[line - 1]!));

describe("hash", () => {
  test("xxHash32 reference vectors", () => {
    expect(xxHash32("")).toBe(0x02cc5d05);
    expect(xxHash32("abc")).toBe(0x32d153ff);
    expect(xxHash32("Nobody inspects the spammish repetition")).toBe(0xe2293b2f);
  });

  test("ids ignore whitespace; punctuation-only lines depend on position", () => {
    expect(lineId(1, "  const x = 1;")).toBe(lineId(9, "const x=1;"));
    expect(lineId(3, "}")).not.toBe(lineId(7, "}"));
    expect(lineId(1, "x")).toMatch(/^[ZPMQVRWSNKTXJBYH]{2}$/);
  });

  test("formats and parses anchors, tolerating copied markers", () => {
    expect(formatLines(["a", "b"], 5)).toBe(`5#${lineId(5, "a")}:a\n6#${lineId(6, "b")}:b`);
    expect(parseAnchor(">>> 12#ZP:text")).toEqual({ line: 12, id: "ZP" });
    expect(() => parseAnchor("12:ab")).toThrow("Invalid line reference");
  });
});

describe("apply", () => {
  test("replace, append and prepend all refer to the original lines", () => {
    const { lines } = applyEdits(FILE, [
      { op: "replace", pos: at(2), lines: ["\tlog(1);"] },
      { op: "prepend", pos: at(5), lines: ["// beta"] },
      { op: "append", lines: ["// end"] },
    ]);
    expect(lines).toEqual(["function alpha() {", "\tlog(1);", "}", "", "// beta", "function beta() {", "\treturn 1;", "}", "// end"]);
  });

  test("range replace and delete", () => {
    expect(applyEdits(FILE, [{ op: "replace", pos: at(4), end: at(7), lines: [] }]).lines).toEqual(FILE.slice(0, 3));
  });

  test("stale anchors fail before any change and show fresh ones", () => {
    const changed = [...FILE];
    changed[1] = "\tlog(2);";
    expect(() => applyEdits(changed, [{ op: "replace", pos: at(2), lines: ["x"] }])).toThrow(StaleAnchorError);
    expect(() => applyEdits(changed, [{ op: "replace", pos: at(2), lines: ["x"] }])).toThrow(`>>> ${formatAnchor(2, "\tlog(2);")}`);
  });

  test("rejects overlapping ranges and wrong current text", () => {
    expect(() =>
      applyEdits(FILE, [
        { op: "replace", pos: at(1), end: at(3), lines: [] },
        { op: "replace", pos: at(3), lines: ["}"] },
      ]),
    ).toThrow("overlap");
    expect(() => applyEdits(FILE, [{ op: "replace", pos: at(2), lines: ["x"], current: "log();" }])).toThrow('"current"');
  });

  test("drops lines echoing the unchanged neighbours of a range", () => {
    const result = applyEdits(FILE, [{ op: "replace", pos: at(6), end: at(6), lines: ["function beta() {", "\treturn 2;", "}"] }]);
    expect(result.lines).toEqual([...FILE.slice(0, 5), "\treturn 2;", "}"]);
    expect(result.warnings).toHaveLength(1);
  });

  test("identical text is no change", () => {
    expect(applyEdits(FILE, [{ op: "replace", pos: at(2), lines: ["\tlog();"] }]).changed).toBe(false);
  });
});

describe("tools", () => {
  const [read, edit] = hashlineTools({ read: "read", edit: "edit" });
  const dir = mkdtempSync(join(tmpdir(), "hashline-"));
  writeFileSync(join(dir, "a.ts"), FILE.join("\n"));

  test("read then edit a file", async () => {
    const shown = (await read!.run({ path: "a.ts", offset: 5, limit: 2 }, dir)).text;
    expect(shown).toBe(`${formatLines(FILE.slice(4, 6), 5)}\n\n[Lines 5-6 of 7.]`);
    const anchor = shown.split(":")[0]!;
    expect(await edit!.run({ path: "a.ts", edits: [{ op: "replace", pos: anchor, lines: ["function gamma() {"] }] }, dir)).toEqual({ text: "Edited a.ts." });
    expect(readFileSync(join(dir, "a.ts"), "utf8")).toContain("function gamma() {");
  });

  test("creates missing files from anchorless inserts", async () => {
    expect((await edit!.run({ path: "new/b.ts", edits: [{ op: "append", lines: ["x"] }] }, dir)).text).toBe("Created new/b.ts.");
    expect(readFileSync(join(dir, "new/b.ts"), "utf8")).toBe("x");
  });

  test("stops a model repeating a no-op edit", async () => {
    const anchor = formatAnchor(1, FILE[0]!);
    const noop = { path: "a.ts", edits: [{ op: "replace", pos: anchor, lines: [FILE[0]] }] };
    await edit!.run(noop, dir);
    await edit!.run(noop, dir);
    expect(await edit!.run(noop, dir)).toMatchObject({ isError: true });
  });
});
