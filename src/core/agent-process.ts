import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

export type SpawnSpec = {
  command: string;
  args: string[];
  env?: Record<string, string>;
};

type SessionListener = {
  onUpdate(notification: acp.SessionNotification): void;
  onPermission(request: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse>;
};

const STDERR_TAIL_BYTES = 16_384;

/**
 * One running ACP agent (adapter or native ACP harness) over stdio.
 * Sessions register a listener; updates and permission requests are routed by sessionId.
 */
export class AgentProcess {
  readonly child: ChildProcess;
  readonly connection: acp.ClientConnection;
  readonly exited: Promise<number | null>;
  private readonly listeners = new Map<string, SessionListener>();
  private stderrTail = "";
  private initResponse?: acp.InitializeResponse;
  readonly spec: SpawnSpec;

  private constructor(spec: SpawnSpec) {
    this.spec = spec;
    this.child = spawn(spec.command, spec.args, {
      env: { ...process.env, ...spec.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    });
    this.exited = new Promise((resolve) => {
      this.child.once("exit", (code) => resolve(code));
      this.child.once("error", () => resolve(null));
    });

    const stream = acp.ndJsonStream(
      Writable.toWeb(this.child.stdin!),
      Readable.toWeb(this.child.stdout!) as ReadableStream<Uint8Array>,
    );

    this.connection = acp
      .client({ name: "neoworks-harness" })
      .onNotification("session/update", ({ params }) => {
        this.listeners.get(params.sessionId)?.onUpdate(params);
      })
      .onRequest("session/request_permission", async ({ params }) => {
        const listener = this.listeners.get(params.sessionId);
        if (!listener) return { outcome: { outcome: "cancelled" } };
        return listener.onPermission(params);
      })
      .connect(stream);

    void this.exited.then(() => this.connection.close(new Error(this.describeExit())));
  }

  static async start(spec: SpawnSpec): Promise<AgentProcess> {
    const agent = new AgentProcess(spec);
    const init = agent.request("initialize", {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "neoworks-harness", version: "0.1.0" },
    });
    agent.initResponse = await Promise.race([
      init,
      agent.exited.then(() => {
        throw new Error(agent.describeExit());
      }),
    ]);
    return agent;
  }

  get initialize(): acp.InitializeResponse {
    return this.initResponse!;
  }

  get alive(): boolean {
    return this.child.exitCode === null && !this.child.killed;
  }

  get sessionCount(): number {
    return this.listeners.size;
  }

  request<M extends acp.AgentRequestMethod>(
    method: M,
    params: acp.AgentRequestParamsByMethod[M],
  ): Promise<acp.AgentRequestResponsesByMethod[M]> {
    return this.connection.agent.request(method, params);
  }

  notify<M extends acp.AgentNotificationMethod>(method: M, params: acp.AgentNotificationParamsByMethod[M]): Promise<void> {
    return this.connection.agent.notify(method, params);
  }

  attach(sessionId: string, listener: SessionListener): () => void {
    this.listeners.set(sessionId, listener);
    return () => {
      if (this.listeners.get(sessionId) === listener) this.listeners.delete(sessionId);
    };
  }

  kill(): void {
    if (this.alive) this.child.kill();
  }

  private describeExit(): string {
    const cmd = [this.spec.command, ...this.spec.args].join(" ");
    const tail = this.stderrTail.trim();
    return `agent process exited (code ${this.child.exitCode}): ${cmd}${tail ? `\n${tail}` : ""}`;
  }
}
