import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SpawnSpec } from "../core/agent-process.ts";

/**
 * Path of a script we spawn, relative to the calling module (`import.meta.url`)
 * and without extension: `.ts` when running from source, `.js` from the build.
 */
export function siblingScript(moduleUrl: string, relative: string): string {
  const extension = extname(fileURLToPath(moduleUrl));
  return fileURLToPath(new URL(`${relative}${extension}`, moduleUrl));
}

const require = createRequire(import.meta.url);

/** Absolute path of a bin script shipped by an npm dependency. */
export function packageBin(pkg: string, bin: string): string {
  const manifestPath = require.resolve(`${pkg}/package.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { bin?: Record<string, string> };
  const rel = manifest.bin?.[bin];
  if (!rel) throw new Error(`${pkg} has no bin "${bin}"`);
  return join(dirname(manifestPath), rel);
}

/**
 * Run a JS or TS entry with the current runtime. Inside Electron `process.execPath`
 * is the Electron binary, which only behaves like node with ELECTRON_RUN_AS_NODE;
 * Node before 23.6 (and Electron's) only strips types behind a flag. Bun needs neither.
 */
export function nodeScript(script: string, args: string[] = [], env: Record<string, string> = {}): SpawnSpec {
  const bun = Boolean(process.versions.bun);
  const electron = Boolean(process.versions.electron);
  const flags = script.endsWith(".ts") && !bun ? ["--experimental-strip-types"] : [];
  return {
    command: process.execPath,
    args: [...flags, script, ...args],
    env: electron ? { ELECTRON_RUN_AS_NODE: "1", ...env } : env,
  };
}

export function onPath(command: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("which", [command], (error, stdout) => resolve(error ? undefined : stdout.trim()));
  });
}
