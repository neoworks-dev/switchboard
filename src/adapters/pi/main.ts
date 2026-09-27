#!/usr/bin/env node
/**
 * ACP agent for pi (https://pi.dev) over stdio. Each ACP session runs its own
 * `pi --mode rpc` process configured from `_meta.neoworks`.
 */
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { sessionOptionsFromMeta } from "../../options.ts";
import type { HookBridge } from "../../drivers/types.ts";
import { HOOKS_META } from "./bridge.ts";
import { findMcpAdapter } from "./launch.ts";
import { PiSession, type StartParams } from "./session.ts";

const sessions = new Map<string, PiSession>();

function session(sessionId: string): PiSession {
  const found = sessions.get(sessionId);
  if (!found) throw acp.RequestError.resourceNotFound(sessionId);
  return found;
}

async function open(params: StartParams, client: acp.AgentContext): Promise<PiSession> {
  const started = await PiSession.start(params, client);
  sessions.set(started.id, started);
  return started;
}

function startParams(request: acp.NewSessionRequest | acp.ResumeSessionRequest): Omit<StartParams, "resume"> {
  try {
    return {
      cwd: request.cwd,
      mcpServers: request.mcpServers ?? [],
      options: sessionOptionsFromMeta(request._meta),
      hooks: request._meta?.[HOOKS_META] as HookBridge | undefined,
    };
  } catch (error) {
    throw acp.RequestError.invalidParams(undefined, `invalid _meta.neoworks: ${String(error)}`);
  }
}

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>);

const connection = acp
  .agent({ name: "neoworks-pi" })
  .onRequest("initialize", () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentInfo: { name: "neoworks-pi", version: "0.1.0" },
    agentCapabilities: {
      promptCapabilities: { image: true, embeddedContext: true },
      mcpCapabilities: { http: findMcpAdapter() !== undefined },
      sessionCapabilities: { resume: {}, close: {} },
    },
    authMethods: [],
  }))
  .onRequest("session/new", async ({ params, client }) => {
    const started = await open(startParams(params), client);
    const response: acp.NewSessionResponse = { sessionId: started.id };
    return Object.assign(response, { models: started.models });
  })
  .onRequest("session/resume", async ({ params, client }) => {
    await sessions.get(params.sessionId)?.close();
    const started = await open({ ...startParams(params), resume: params.sessionId }, client);
    const response: acp.ResumeSessionResponse = {};
    return Object.assign(response, { models: started.models });
  })
  .onRequest("session/prompt", ({ params }) => session(params.sessionId).prompt(params.prompt))
  .onNotification("session/cancel", ({ params }) => session(params.sessionId).cancel())
  .onRequest("session/close", async ({ params }) => {
    await session(params.sessionId).close();
    sessions.delete(params.sessionId);
  })
  .connect(stream);

await connection.closed;
await Promise.all([...sessions.values()].map((piSession) => piSession.close()));
