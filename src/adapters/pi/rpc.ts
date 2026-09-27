import { spawn, type ChildProcess } from "node:child_process";
import { EVENT_TYPES, type CommandType, type Commands, type Event, type Response, type UiRequest, type UiResponse } from "./protocol.ts";

type Pending = { resolve(data: unknown): void; reject(error: Error): void };

type RecordFromPi = Response | UiRequest | Event | { type: string };

export type PiRpcOptions = {
  cwd: string;
  env?: Record<string, string>;
  /** Defaults to `pi` on PATH. */
  command?: string;
};

const STDERR_TAIL_BYTES = 8_192;

/**
 * Client for one `pi --mode rpc` child process.
 *
 * Records are JSONL framed on LF only: Node's `readline` would also split on
 * U+2028/U+2029, which are legal inside JSON strings (pi docs/rpc.md).
 */
export class PiRpc {
  readonly exited: Promise<number | null>;
  onEvent: (event: Event) => void = () => {};
  onUiRequest: (request: UiRequest) => void = () => {};

  private readonly child: ChildProcess;
  private readonly pending = new Map<string, Pending>();
  private nextId = 0;
  private stdoutBuffer = "";
  private stderrTail = "";

  constructor(args: string[], options: PiRpcOptions) {
    this.child = spawn(options.command ?? "pi", ["--mode", "rpc", ...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout!.setEncoding("utf8").on("data", (chunk: string) => this.receive(chunk));
    this.child.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    });
    this.exited = new Promise((resolve) => {
      this.child.once("exit", resolve);
      this.child.once("error", (error) => {
        this.stderrTail += `\n${error.message}`;
        resolve(null);
      });
    });
    void this.exited.then(() => this.rejectPending(new Error(this.describeExit())));
  }

  request<C extends CommandType>(type: C, params: Commands[C]["params"]): Promise<Commands[C]["result"]> {
    const id = String(++this.nextId);
    const result = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.send({ ...params, type, id });
    return result as Promise<Commands[C]["result"]>;
  }

  respond(response: UiResponse): void {
    this.send(response);
  }

  /** Orderly shutdown: pi disposes its runtime once stdin closes. */
  async close(timeoutMs = 3_000): Promise<void> {
    if (this.child.exitCode !== null) return;
    this.child.stdin!.end();
    const timer = setTimeout(() => this.child.kill(), timeoutMs);
    await this.exited;
    clearTimeout(timer);
  }

  describeExit(): string {
    const tail = this.stderrTail.trim();
    return `pi exited with code ${this.child.exitCode}${tail ? `: ${tail}` : ""}`;
  }

  private send(record: object): void {
    this.child.stdin!.write(`${JSON.stringify(record)}\n`);
  }

  private receive(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline: number;
    while ((newline = this.stdoutBuffer.indexOf("\n")) !== -1) {
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line) this.dispatch(JSON.parse(line) as RecordFromPi);
    }
  }

  private dispatch(record: RecordFromPi): void {
    if (isResponse(record)) {
      const waiter = record.id === undefined ? undefined : this.pending.get(record.id);
      if (!waiter) return;
      this.pending.delete(record.id!);
      if (record.success) waiter.resolve(record.data);
      else waiter.reject(new Error(`pi ${record.command}: ${record.error}`));
    } else if (record.type === "extension_ui_request") {
      this.onUiRequest(record as UiRequest);
    } else if (EVENT_TYPES.has(record.type)) {
      this.onEvent(record as Event);
    }
  }

  private rejectPending(error: Error): void {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }
}

function isResponse(record: RecordFromPi): record is Response {
  return record.type === "response";
}
