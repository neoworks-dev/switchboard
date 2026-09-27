import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HarnessClient } from "../src/client/index.ts";
import { Harness } from "../src/core/harness.ts";
import { serve, type Sidecar } from "../src/server/serve.ts";
import type { HarnessApi } from "../src/types.ts";
import { collect, fakeDriver } from "./fixtures/fake-driver.ts";

// The same checks run against the in-process Harness and against a HarnessClient
// talking to a sidecar, since both implement HarnessApi.
const local = new Harness({}, [fakeDriver]);
let sidecar: Sidecar;
let remote: HarnessClient;

beforeAll(async () => {
  sidecar = await serve({ harness: new Harness({}, [fakeDriver]) });
  remote = await HarnessClient.connect({ url: sidecar.url, token: sidecar.token });
});

afterAll(async () => {
  await remote.close();
  await sidecar.close();
  await local.close();
});

const apis: Array<[string, () => HarnessApi]> = [
  ["local", () => local],
  ["remote", () => remote],
];

describe.each(apis)("%s HarnessApi", (_name, api) => {
  test("lists harnesses", async () => {
    expect(await api().listHarnesses()).toEqual([{ id: "claude", available: true, capabilities: {} as never, efforts: ["low"] }]);
  });

  test("a prompt streams and resolves", async () => {
    const session = await api().createSession({ cwd: "/tmp" });
    expect(session.harness).toBe("claude");
    const run = session.prompt("hello");
    const { text } = await collect(run);
    expect(text).toBe("echo: hello");
    expect(await run).toMatchObject({ stopReason: "end_turn", usage: { input: 10, output: 5, costUsd: 0.25 } });
    await session.close();
  });

  test("permissions take shorthand replies", async () => {
    const session = await api().createSession({ cwd: "/tmp", onPermission: () => "once" });
    const { text, permissions } = await collect(session.prompt("permission please"));
    expect(text).toBe("yes");
    expect(permissions).toBe(1);
    await session.close();
  });

  test("hooks reach the app's function", async () => {
    const session = await api().createSession({
      cwd: "/tmp",
      hooks: { beforeToolUse: (event) => (event.toolName === "Bash" ? { block: `no ${event.toolName}` } : undefined) },
    });
    expect(JSON.parse((await collect(session.prompt("hook Bash"))).text)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "no Bash" },
    });
    expect((await collect(session.prompt("hook Read"))).text).toBe("(no output)");
    await session.close();
  });

  test("onEvent sees every turn", async () => {
    const session = await api().createSession({ cwd: "/tmp" });
    const seen: string[] = [];
    session.onEvent((event) => seen.push(event.type));
    await session.prompt("one");
    expect(seen).toEqual(["update", "update", "done"]);
    await session.close();
  });
});

describe("sidecar", () => {
  test("refuses a wrong token", async () => {
    await expect(HarnessClient.connect({ url: sidecar.url, token: "wrong" })).rejects.toThrow();
  });
});
