#!/usr/bin/env node
/**
 * What a harness runs for each command hook: `runner.ts <claude|codex> <hook> <address>`.
 * Translates the harness's hook JSON, asks the backend's `HookServer`, and
 * prints the answer in the harness's format. Prints nothing when the backend
 * has no opinion, which the harness reads as "carry on".
 */
import { text } from "node:stream/consumers";
import { COMMAND_EVENTS, fromCommandInput, toCommandOutput, type CommandHookFormat } from "./command-hooks.ts";
import type { HookName } from "./types.ts";
import { callHook } from "./wire.ts";

const [format, hook, address] = process.argv.slice(2);
if ((format !== "claude" && format !== "codex") || !hook || !(hook in COMMAND_EVENTS) || !address) {
  console.error("usage: runner.ts <claude|codex> <hook> <address>");
  process.exit(1);
}

const name = hook as HookName;
const event = fromCommandInput(name, JSON.parse(await text(process.stdin)), { harness: format as CommandHookFormat });
const output = event && (await callHook(address, { hook: name, event }));
const reply = toCommandOutput(format, name, output);
if (reply) process.stdout.write(JSON.stringify(reply));
