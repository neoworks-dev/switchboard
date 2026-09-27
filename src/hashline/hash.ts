/**
 * Hashline addressing: every line is shown as `LINE#ID:text`, where ID is a
 * two-letter hash of the line's non-whitespace text. Edits cite `LINE#ID`, so
 * the model never has to reproduce old text, and a stale read is caught before
 * anything is written.
 *
 * Format and hash follow oh-my-pi's hashline mode (https://github.com/can1357/oh-my-pi,
 * MIT, Copyright (c) 2026 Can Bölük) as ported to pi by @the-agency/pi-hashline-edit
 * (MIT, Copyright (c) 2026 Josh Mock).
 */

const ALPHABET = "ZPMQVRWSNKTXJBYH";
const IDS = Array.from({ length: 256 }, (_, byte) => `${ALPHABET[byte >>> 4]}${ALPHABET[byte & 0xf]}`);
const HAS_WORD_CHAR = /[\p{L}\p{N}]/u;
const ANCHOR = /^\s*[>+-]*\s*(\d+)\s*#\s*([ZPMQVRWSNKTXJBYH]{2})/;

export type Anchor = { line: number; id: string };

/**
 * The ID of line `lineNumber` (1-based). Whitespace is ignored. Lines with no
 * letters or digits (blank lines, lone braces) mix in their line number, so
 * they don't all share an ID.
 */
export function lineId(lineNumber: number, text: string): string {
  const normalized = text.replace(/\s+/g, "");
  const seed = HAS_WORD_CHAR.test(normalized) ? 0 : lineNumber;
  return IDS[xxHash32(normalized, seed) & 0xff]!;
}

export function formatAnchor(lineNumber: number, text: string): string {
  return `${lineNumber}#${lineId(lineNumber, text)}`;
}

/** Render lines as `LINE#ID:text`, numbering from `firstLine`. */
export function formatLines(lines: readonly string[], firstLine = 1): string {
  return lines.map((text, i) => `${formatAnchor(firstLine + i, text)}:${text}`).join("\n");
}

/** Parse `"5#ZP"`. Tolerates a copied `>>>` marker and trailing `:text`. */
export function parseAnchor(ref: string): Anchor {
  const match = ANCHOR.exec(ref);
  if (!match) throw new Error(`Invalid line reference "${ref}". Expected "LINE#ID", e.g. "5#ZP".`);
  const line = Number(match[1]);
  if (line < 1) throw new Error(`Line numbers start at 1, got "${ref}".`);
  return { line, id: match[2]! };
}

const P1 = 0x9e3779b1;
const P2 = 0x85ebca77;
const P3 = 0xc2b2ae3d;
const P4 = 0x27d4eb2f;
const P5 = 0x165667b1;
const encoder = new TextEncoder();

const rotl = (x: number, r: number) => (x << r) | (x >>> (32 - r));
const round = (acc: number, word: number) => Math.imul(rotl((acc + Math.imul(word, P2)) >>> 0, 13), P1) >>> 0;

/** xxHash32 of the UTF-8 bytes of `text`, the same value as omp's `Bun.hash.xxHash32`. */
export function xxHash32(text: string, seed = 0): number {
  const data = encoder.encode(text);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const length = data.length;
  let offset = 0;
  let hash: number;

  if (length >= 16) {
    let v1 = (seed + P1 + P2) >>> 0;
    let v2 = (seed + P2) >>> 0;
    let v3 = seed >>> 0;
    let v4 = (seed - P1) >>> 0;
    for (; offset <= length - 16; offset += 16) {
      v1 = round(v1, view.getUint32(offset, true));
      v2 = round(v2, view.getUint32(offset + 4, true));
      v3 = round(v3, view.getUint32(offset + 8, true));
      v4 = round(v4, view.getUint32(offset + 12, true));
    }
    hash = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) >>> 0;
  } else {
    hash = (seed + P5) >>> 0;
  }
  hash = (hash + length) >>> 0;

  for (; offset <= length - 4; offset += 4) {
    hash = Math.imul(rotl((hash + Math.imul(view.getUint32(offset, true), P3)) >>> 0, 17), P4) >>> 0;
  }
  for (; offset < length; offset++) {
    hash = Math.imul(rotl((hash + Math.imul(data[offset]!, P5)) >>> 0, 11), P1) >>> 0;
  }

  hash ^= hash >>> 15;
  hash = Math.imul(hash, P2) >>> 0;
  hash ^= hash >>> 13;
  hash = Math.imul(hash, P3) >>> 0;
  hash ^= hash >>> 16;
  return hash >>> 0;
}
