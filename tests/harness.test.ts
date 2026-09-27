import { afterAll, describe, expect, test } from "bun:test";
import { Harness } from "../src/core/harness.ts";
import { ProcessPool } from "../src/core/pool.ts";
import { HookServer } from "../src/hooks/server.ts";
import { callHook } from "../src/hooks/wire.ts";
import { collect, FAKE_AGENT, fakeDriver as fake } from "./fixtures/fake-driver.ts";

const harness = new Harness({}, [fake]);
afterAll(() => harness.close());

describe("session", () => {
  test("streams text and ends with per-turn usage", async () => {
    const session = await harness.createSession({ cwd: "/tmp" });
    const first = await collect(session.prompt("hello"));
    expect(first.text).toBe("echo: hello");
    expect(first.done?.stopReason).toBe("end_turn");
    expect(first.done?.usage).toEqual({ input: 10, output: 5, cacheRead: undefined, cacheWrite: undefined, costUsd: 0.25 });

    // The agent reports cumulative cost (0.5 now); a turn reports only its delta.
    const second = await collect(session.prompt("again"));
    expect(second.done?.usage?.costUsd).toBe(0.25);
    session.close();
  });

  test("sends neoworks options and driver meta on session/new", async () => {
    const session = await harness.createSession({ cwd: "/tmp", options: { tools: "none", effort: "low" } });
    const { text } = await collect(session.prompt("meta"));
    expect(JSON.parse(text)).toEqual({ driverSaw: "no-tools", neoworks: { tools: "none", effort: "low" } });
    session.close();
  });

  test("declines permissions by default", async () => {
    const session = await harness.createSession({ cwd: "/tmp" });
    const result = await collect(session.prompt("permission please"));
    expect(result.text).toBe("no");
    expect(result.permissions).toBe(1);
    session.close();
  });

  test("routes permissions to the session's handler", async () => {
    const session = await harness.createSession({
      cwd: "/tmp",
      onPermission: () => ({ outcome: { outcome: "selected", optionId: "yes" } }),
    });
    expect((await collect(session.prompt("permission please"))).text).toBe("yes");
    session.close();
  });

  test("breaking out of a prompt cancels the turn", async () => {
    const session = await harness.createSession({ cwd: "/tmp" });
    const run = session.prompt("slow");
    for await (const event of run) {
      if (event.type === "update") break;
    }
    expect((await run).stopReason).toBe("cancelled");
    expect(session.running).toBe(false);
    expect((await collect(session.prompt("after"))).text).toBe("echo: after");
    session.close();
  });

  test("keeps concurrent sessions on one process apart", async () => {
    const [a, b] = await Promise.all([harness.createSession({ cwd: "/tmp" }), harness.createSession({ cwd: "/tmp" })]);
    const [ra, rb] = await Promise.all([collect(a.prompt("from a")), collect(b.prompt("from b"))]);
    expect(ra.text).toBe("echo: from a");
    expect(rb.text).toBe("echo: from b");
    a.close();
    b.close();
  });

  test("rejects http MCP servers the agent can't take", async () => {
    const noHttp = new Harness({}, [
      { ...fake, spawn: async () => ({ command: process.execPath, args: [FAKE_AGENT], env: { FAKE_NO_HTTP_MCP: "1" } }) },
    ]);
    try {
      await expect(
        noHttp.createSession({ cwd: "/tmp", mcpServers: [{ type: "http", name: "app", url: "http://127.0.0.1:1/mcp", headers: [] }] }),
      ).rejects.toThrow("does not support http MCP");
    } finally {
      await noHttp.close();
    }
  });
});

describe("hooks", () => {
  test("a harness's command hook reaches the session's beforeToolUse", async () => {
    const seen: string[] = [];
    const session = await harness.createSession({
      cwd: "/tmp",
      hooks: {
        beforeToolUse: (event) => {
          seen.push(`${event.harness}:${event.sessionId}:${event.toolName}`);
          if (event.toolName === "Bash") return { block: "no shell here" };
        },
      },
    });
    const blocked = JSON.parse((await collect(session.prompt("hook Bash"))).text);
    expect(blocked).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "no shell here" } });
    expect((await collect(session.prompt("hook Read"))).text).toBe("(no output)");
    expect(seen).toEqual([`claude:${session.id}:Bash`, `claude:${session.id}:Read`]);
    session.close();
  });

  test("the server routes by session and stops after unregistering", async () => {
    const server = await HookServer.start();
    const event = { sessionId: "s1", harness: "codex" as const, toolName: "shell", input: {} };
    const unregister = server.register("s1", { beforeToolUse: () => ({ block: "no" }) });
    expect(await callHook(server.address, { hook: "beforeToolUse", event })).toEqual({ block: "no" });
    expect(await callHook(server.address, { hook: "beforeToolUse", event: { ...event, sessionId: "s2" } })).toBeUndefined();
    unregister();
    expect(await callHook(server.address, { hook: "beforeToolUse", event })).toBeUndefined();
    await server.close();
    // A harness outliving its backend carries on.
    expect(await callHook(server.address, { hook: "beforeToolUse", event })).toBeUndefined();
  });
});

describe("pool", () => {
  test("shares a process per spawn spec", async () => {
    const pool = new ProcessPool();
    try {
      const spec = (tag: string) => ({ command: process.execPath, args: [FAKE_AGENT], env: { FAKE_TAG: tag } });
      const [a, b, c] = await Promise.all([pool.acquire(spec("x")), pool.acquire(spec("x")), pool.acquire(spec("y"))]);
      expect(a).toBe(b);
      expect(a).not.toBe(c);
      expect(c.initialize._meta?.env).toBe("y");
    } finally {
      await pool.close();
    }
  });

  test("replaces a dead process", async () => {
    const pool = new ProcessPool();
    try {
      const spec = { command: process.execPath, args: [FAKE_AGENT] };
      const first = await pool.acquire(spec);
      first.kill();
      await first.exited;
      const second = await pool.acquire(spec);
      expect(second).not.toBe(first);
      expect(second.alive).toBe(true);
    } finally {
      await pool.close();
    }
  });
});
