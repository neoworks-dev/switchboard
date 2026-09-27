import * as acp from "@agentclientprotocol/sdk";
import type { HookName, Hooks } from "../hooks/types.ts";
import { sessionOptionsFromMeta } from "../options.ts";
import { METHODS, SESSION_META, type SessionMeta } from "../shared/wire.ts";
import type { HarnessApi, HarnessId, HarnessSession, SessionInit } from "../types.ts";

const VERSION = "0.1.0";

export type ServedConnection = {
  /** Resolves once the connection ended and its sessions are closed. */
  closed: Promise<void>;
  close(): void;
};

/**
 * Serve `harness` as an ACP agent over one client connection. Sessions opened
 * on the connection close with it; the harness itself stays up.
 */
export function serveConnection(harness: HarnessApi, stream: acp.Stream): ServedConnection {
  const sessions = new Map<string, HarnessSession>();

  const find = (sessionId: string) => {
    const session = sessions.get(sessionId);
    if (!session) throw acp.RequestError.resourceNotFound(sessionId);
    return session;
  };

  const open = async (request: SessionRequest, client: acp.AgentContext, resume?: string) => {
    const init = sessionInit(request, client);
    const session = resume ? await harness.resumeSession(resume, init) : await harness.createSession(init);
    await sessions.get(session.id)?.close();
    sessions.set(session.id, session);
    session.onEvent((event) => {
      if (event.type === "update") void client.notify("session/update", { sessionId: session.id, update: event.update });
    });
    return session;
  };

  const connection = acp
    .agent({ name: "neoworks-harness" })
    .onRequest("initialize", () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: { name: "neoworks-harness", version: VERSION },
      agentCapabilities: {
        promptCapabilities: { image: true, audio: true, embeddedContext: true },
        mcpCapabilities: { http: true, sse: true },
        sessionCapabilities: { resume: {}, close: {} },
      },
      authMethods: [],
    }))
    .onRequest(METHODS.harnesses, () => undefined, () => harness.listHarnesses())
    .onRequest(METHODS.models, parseModelsParams, ({ params }) => harness.listModels(params.harness))
    .onRequest("session/new", async ({ params, client }) => {
      const session = await open(params, client);
      return { sessionId: session.id, _meta: { [SESSION_META]: { harness: session.harness } } };
    })
    .onRequest("session/resume", async ({ params, client }) => {
      const session = await open(params, client, params.sessionId);
      return { _meta: { [SESSION_META]: { harness: session.harness } } };
    })
    .onRequest("session/prompt", async ({ params }) => {
      const { response, usage } = await find(params.sessionId).prompt(params.prompt);
      // The client can't see the cumulative cost baseline; hand over this turn's.
      const neoworks = { ...(response._meta?.neoworks as object | undefined), costUsd: usage?.costUsd };
      return { ...response, _meta: { ...response._meta, neoworks } };
    })
    .onNotification("session/cancel", ({ params }) => find(params.sessionId).cancel())
    .onRequest("session/close", async ({ params }) => {
      await find(params.sessionId).close();
      sessions.delete(params.sessionId);
    })
    .connect(stream);

  const closed = connection.closed.then(async () => {
    await Promise.all([...sessions.values()].map((session) => session.close()));
  });
  return { closed, close: () => connection.close() };
}

type SessionRequest = Pick<acp.NewSessionRequest, "cwd" | "_meta"> & { mcpServers?: acp.McpServer[] };

/** Rebuild the app's `SessionInit`, with permissions and hooks answered by the client. */
function sessionInit(request: SessionRequest, client: acp.AgentContext): SessionInit {
  let options;
  try {
    options = sessionOptionsFromMeta(request._meta);
  } catch (error) {
    throw acp.RequestError.invalidParams(undefined, `invalid _meta.neoworks: ${String(error)}`);
  }
  const meta = (request._meta?.[SESSION_META] ?? {}) as SessionMeta;
  const init: SessionInit = {
    harness: meta.harness,
    cwd: request.cwd || undefined,
    mcpServers: request.mcpServers,
    options,
    onPermission: (permission) => client.request("session/request_permission", permission),
  };
  if (meta.hooks?.length) {
    init.hooks = remoteHooks(meta.hooks, client);
  }
  return init;
}

/** Hooks that ask the client. A `null` answer means "carry on". */
function remoteHooks(names: HookName[], client: acp.AgentContext): Hooks {
  const hooks: Record<string, (event: { sessionId: string }) => Promise<unknown>> = {};
  for (const hook of names) {
    hooks[hook] = async (event) => (await client.request(METHODS.hook, { sessionId: event.sessionId, hook, event })) ?? undefined;
  }
  return hooks as Hooks;
}

function parseModelsParams(params: unknown): { harness: HarnessId } {
  const harness = (params as { harness?: unknown } | undefined)?.harness;
  if (typeof harness !== "string") throw acp.RequestError.invalidParams(undefined, "harness is required");
  return { harness: harness as HarnessId };
}
