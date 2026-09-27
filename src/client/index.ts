/**
 * `HarnessClient`: the SDK for apps that reach the harnesses through a
 * sidecar (`neoworks-harness serve`), e.g. a sandboxed Electron renderer.
 * Runs in browsers and Node; same `HarnessApi` as the in-process `Harness`.
 */
import * as acp from "@agentclientprotocol/sdk";
import type { HookName } from "../hooks/types.ts";
import { toPermissionResponse } from "../shared/permission.ts";
import { PromptRun } from "../shared/prompt-run.ts";
import { toUsage } from "../shared/usage.ts";
import { opened, webSocketStream, type WebSocketLike } from "../shared/websocket-stream.ts";
import { METHODS, SESSION_META, type HookRequest, type SessionMeta } from "../shared/wire.ts";
import type {
  HarnessApi,
  HarnessEvent,
  HarnessId,
  HarnessInfo,
  HarnessSession,
  ModelInfo,
  PermissionHandler,
  SessionInit,
} from "../types.ts";

export type * from "../types.ts";
export type {
  ContentBlock,
  McpServer,
  RequestPermissionRequest,
  SessionUpdate,
  StopReason,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";

export type ConnectOptions = {
  /** The sidecar's `ws://` url, as it printed it. */
  url: string;
  token: string;
  /** Node before 22 has no global WebSocket; pass `ws`'s. */
  WebSocket?: new (url: string) => WebSocketLike & { addEventListener(type: "open", listener: () => void): void };
};

export class HarnessClient implements HarnessApi {
  private readonly sessions = new Map<string, RemoteSession>();
  private connection!: acp.ClientConnection;

  private constructor() {}

  static async connect({ url, token, WebSocket = globalThis.WebSocket }: ConnectOptions): Promise<HarnessClient> {
    const client = new HarnessClient();
    const endpoint = new URL(url);
    endpoint.searchParams.set("token", token);
    const socket = new WebSocket(endpoint.toString());
    await opened(socket);
    client.connection = acp
      .client({ name: "neoworks-harness-client" })
      .onNotification("session/update", ({ params }) => client.sessions.get(params.sessionId)?.emit({ type: "update", update: params.update }))
      .onRequest("session/request_permission", async ({ params }) => {
        const session = client.sessions.get(params.sessionId);
        if (!session) return { outcome: { outcome: "cancelled" } };
        return session.answerPermission(params);
      })
      .onRequest(METHODS.hook, (params) => params as HookRequest, async ({ params }) => {
        const output = await client.sessions.get(params.sessionId)?.runHook(params.hook, params.event);
        return output ?? null;
      })
      .connect(webSocketStream(socket));
    socket.addEventListener("close", () => client.connection.close());
    await client.connection.agent.request("initialize", {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "neoworks-harness-client", version: "0.1.0" },
    });
    return client;
  }

  /** Resolves when the sidecar connection ends. */
  get closed(): Promise<void> {
    return this.connection.closed;
  }

  listHarnesses(): Promise<HarnessInfo[]> {
    return this.connection.agent.request<HarnessInfo[]>(METHODS.harnesses);
  }

  listModels(harness: HarnessId): Promise<ModelInfo[]> {
    return this.connection.agent.request<ModelInfo[]>(METHODS.models, { harness });
  }

  async createSession(init: SessionInit): Promise<HarnessSession> {
    const response = await this.connection.agent.request("session/new", sessionRequest(init));
    return this.track(response.sessionId, init, chosenHarness(response._meta));
  }

  async resumeSession(sessionId: string, init: SessionInit): Promise<HarnessSession> {
    const response = await this.connection.agent.request("session/resume", { ...sessionRequest(init), sessionId });
    return this.track(sessionId, init, chosenHarness(response._meta));
  }

  async close(): Promise<void> {
    this.connection.close();
    await this.connection.closed.catch(() => {});
  }

  private track(sessionId: string, init: SessionInit, harness: HarnessId): RemoteSession {
    const session = new RemoteSession(this.connection, sessionId, harness, init, () => this.sessions.delete(sessionId));
    this.sessions.set(sessionId, session);
    return session;
  }
}

class RemoteSession implements HarnessSession {
  readonly id: string;
  readonly harness: HarnessId;
  private readonly connection: acp.ClientConnection;
  private readonly init: SessionInit;
  private readonly forget: () => void;
  private readonly listeners = new Set<(event: HarnessEvent) => void>();
  private run?: PromptRun;

  constructor(connection: acp.ClientConnection, id: string, harness: HarnessId, init: SessionInit, forget: () => void) {
    this.connection = connection;
    this.id = id;
    this.harness = harness;
    this.init = init;
    this.forget = forget;
  }

  prompt(content: string | acp.ContentBlock[]): PromptRun {
    if (this.run) throw new Error(`session ${this.id} already has a prompt running`);
    const prompt: acp.ContentBlock[] = typeof content === "string" ? [{ type: "text", text: content }] : content;
    const run = new PromptRun(() => void this.cancel());
    this.run = run;
    this.connection.agent.request("session/prompt", { sessionId: this.id, prompt }).then(
      (response) => {
        this.run = undefined;
        const result = { stopReason: response.stopReason, usage: toUsage(response), response };
        run.finish(result);
        this.notify({ type: "done", ...result });
      },
      (error: unknown) => {
        this.run = undefined;
        run.fail(error);
      },
    );
    return run;
  }

  onEvent(listener: (event: HarnessEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async cancel(): Promise<void> {
    await this.connection.agent.notify("session/cancel", { sessionId: this.id });
  }

  async close(): Promise<void> {
    this.forget();
    await this.connection.agent.request("session/close", { sessionId: this.id });
  }

  emit(event: HarnessEvent): void {
    this.run?.push(event);
    this.notify(event);
  }

  async answerPermission(request: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    this.emit({ type: "permission", request });
    const handler: PermissionHandler = this.init.onPermission ?? (() => "reject");
    return toPermissionResponse(request, await handler(request));
  }

  async runHook(hook: HookName, event: unknown): Promise<unknown> {
    const handler = this.init.hooks?.[hook] as ((event: unknown) => unknown) | undefined;
    return handler ? await handler(event) : undefined;
  }

  private notify(event: HarnessEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function chosenHarness(meta: Record<string, unknown> | null | undefined): HarnessId {
  const harness = (meta?.[SESSION_META] as SessionMeta | undefined)?.harness;
  if (!harness) throw new Error("the sidecar did not say which harness it started");
  return harness;
}

function sessionRequest(init: SessionInit): acp.NewSessionRequest {
  const meta: SessionMeta = { harness: init.harness, hooks: Object.keys(init.hooks ?? {}) as HookName[] };
  return {
    // ACP requires the field; the sidecar reads an empty one as "use your own".
    cwd: init.cwd ?? "",
    mcpServers: init.mcpServers ?? [],
    _meta: { neoworks: init.options ?? {}, [SESSION_META]: meta },
  };
}
