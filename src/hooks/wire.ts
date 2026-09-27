/**
 * Wire format between hook runners (processes the harness starts) and the
 * `HookServer` in the backend: one connection per hook call, one JSON line each
 * way over a Unix socket or Windows named pipe.
 */
import { connect } from "node:net";
import type { HookEvent, HookName, HookOutput } from "./types.ts";

export type HookCall<N extends HookName = HookName> = { hook: N; event: HookEvent<N> };

export type HookReply<N extends HookName = HookName> = { output?: HookOutput<N> };

/** Env var carrying the server address into hook runners. */
export const HOOK_SOCKET_ENV = "NEOWORKS_HOOK_SOCKET";

/**
 * Ask the backend. Resolves to no output when nothing is listening, so a
 * harness outliving its backend keeps working instead of stalling on hooks.
 */
export function callHook<N extends HookName>(address: string, call: HookCall<N>): Promise<HookOutput<N> | undefined> {
  return new Promise((resolve) => {
    const socket = connect(address);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(call)}\n`));
    socket.on("data", (chunk: string) => (buffer += chunk));
    socket.on("end", () => resolve(parseReply<N>(buffer)?.output));
    socket.on("error", () => resolve(undefined));
  });
}

export function parseReply<N extends HookName>(line: string): HookReply<N> | undefined {
  try {
    return JSON.parse(line) as HookReply<N>;
  } catch {
    return undefined;
  }
}
