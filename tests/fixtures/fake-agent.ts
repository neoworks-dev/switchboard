// Minimal ACP agent over stdio for tests. Echoes prompts, reports cumulative
// cost like claude-agent-acp, and asks for permission when the prompt says so.
// Prompt "meta" replies with the `_meta` the session was created with;
// "hook <tool>" runs `_meta.hookCommand` like Claude Code runs a PreToolUse hook.
import { execSync } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const sessions = new Map<string, { meta: unknown; cost: number; cancelled: boolean }>();
let nextId = 0;

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);

acp
  .agent({ name: "fake-agent" })
  .onRequest("initialize", () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { mcpCapabilities: { http: process.env.FAKE_NO_HTTP_MCP !== "1" } },
    authMethods: [],
    _meta: { env: process.env.FAKE_TAG ?? null, pid: process.pid },
  }))
  .onRequest("session/new", ({ params }) => {
    const sessionId = `fake-${++nextId}`;
    sessions.set(sessionId, { meta: params._meta ?? null, cost: 0, cancelled: false });
    return { sessionId };
  })
  .onRequest("session/set_mode", () => ({}))
  .onNotification("session/cancel", ({ params }) => {
    const session = sessions.get(params.sessionId);
    if (session) session.cancelled = true;
  })
  .onRequest("session/prompt", async ({ params, client }) => {
    const session = sessions.get(params.sessionId)!;
    session.cancelled = false;
    const text = params.prompt.map((block) => (block.type === "text" ? block.text : `[${block.type}]`)).join(" ");
    const say = (chunk: string) =>
      client.notify("session/update", {
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk } },
      });

    if (text === "meta") {
      await say(JSON.stringify(session.meta));
    } else if (text.startsWith("hook ")) {
      const command = (session.meta as { hookCommand: string }).hookCommand;
      const input = { session_id: params.sessionId, cwd: "/tmp", tool_name: text.slice(5), tool_input: { command: "ls" }, tool_use_id: "t1" };
      await say(execSync(command, { input: JSON.stringify(input), encoding: "utf8" }) || "(no output)");
    } else if (text === "slow") {
      for (let i = 0; i < 50 && !session.cancelled; i++) {
        await say(".");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (session.cancelled) return { stopReason: "cancelled" };
    } else if (text.startsWith("permission")) {
      const response = await client.request("session/request_permission", {
        sessionId: params.sessionId,
        toolCall: { toolCallId: "t1", title: "Write file" },
        options: [
          { optionId: "yes", name: "Allow", kind: "allow_once" },
          { optionId: "no", name: "Reject", kind: "reject_once" },
        ],
      });
      await say(response.outcome.outcome === "selected" ? response.outcome.optionId : "cancelled");
    } else {
      await say(`echo: ${text}`);
    }

    session.cost += 0.25;
    await client.notify("session/update", {
      sessionId: params.sessionId,
      update: { sessionUpdate: "usage_update", used: 100, size: 1000, cost: { amount: session.cost, currency: "USD" } },
    });
    return { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
  })
  .connect(stream);
