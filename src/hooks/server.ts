import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hooks } from "./types.ts";
import type { HookCall, HookReply } from "./wire.ts";

/**
 * Receives hook calls from harness processes and routes them to the hooks the
 * app registered for that session. Listens on a Unix socket inside a fresh
 * 0700 directory (a named pipe on Windows), so only this user can reach it.
 */
export class HookServer {
  readonly address: string;
  private readonly server: Server;
  private readonly sessions = new Map<string, Hooks>();
  private readonly dir?: string;

  private constructor(server: Server, address: string, dir?: string) {
    this.server = server;
    this.address = address;
    this.dir = dir;
  }

  static async start(): Promise<HookServer> {
    const dir = process.platform === "win32" ? undefined : mkdtempSync(join(tmpdir(), "neoworks-hooks-"));
    const address = dir ? join(dir, "hooks.sock") : `\\\\.\\pipe\\neoworks-hooks-${process.pid}-${Date.now()}`;
    const server = createServer();
    const hookServer = new HookServer(server, address, dir);
    server.on("connection", (socket) => hookServer.serve(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(address, resolve);
    });
    return hookServer;
  }

  /** Route this session's hook calls to `hooks`. Returns the unregister function. */
  register(sessionId: string, hooks: Hooks): () => void {
    this.sessions.set(sessionId, hooks);
    return () => {
      if (this.sessions.get(sessionId) === hooks) this.sessions.delete(sessionId);
    };
  }

  close(): Promise<void> {
    return new Promise((resolve) =>
      this.server.close(() => {
        if (this.dir) rmSync(this.dir, { recursive: true, force: true });
        resolve();
      }),
    );
  }

  private serve(socket: Socket): void {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", async (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      socket.removeAllListeners("data");
      const reply = await this.dispatch(buffer.slice(0, newline)).catch((error: unknown) => {
        console.error("[neoworks-harness] hook failed:", error);
        return {};
      });
      socket.end(`${JSON.stringify(reply)}\n`);
    });
    socket.on("error", () => socket.destroy());
  }

  private async dispatch(line: string): Promise<HookReply> {
    const call = JSON.parse(line) as HookCall;
    const hook = this.sessions.get(call.event.sessionId)?.[call.hook] as
      | ((event: HookCall["event"]) => Promise<HookReply["output"]> | HookReply["output"])
      | undefined;
    if (!hook) return {};
    const output = await hook(call.event);
    return output ? { output } : {};
  }
}
