import type * as acp from "@agentclientprotocol/sdk";
import { toPermissionResponse } from "../shared/permission.ts";
import { PromptRun } from "../shared/prompt-run.ts";
import { toUsage } from "../shared/usage.ts";
import type { HarnessEvent, HarnessId, HarnessSession, PermissionHandler } from "../types.ts";
import type { AgentProcess } from "./agent-process.ts";

/** Safe default when the app registered no handler: decline once. */
export const rejectPermission: PermissionHandler = () => "reject";

export type SessionSetup = {
  onPermission: PermissionHandler;
  /** Resumed sessions start with an unknown cost baseline. */
  resumed?: boolean;
  unregisterHooks?: () => void;
};

/** A session on an agent process in this process's pool. */
export class Session implements HarnessSession {
  readonly id: string;
  readonly harness: HarnessId;
  private readonly agent: AgentProcess;
  private readonly listeners = new Set<(event: HarnessEvent) => void>();
  private readonly detach: () => void;
  private run?: PromptRun;
  /**
   * Cumulative cost as last reported by `usage_update`; a turn's cost is the
   * delta. Unknown for resumed sessions until the first report.
   */
  private costTotal?: number;

  constructor(agent: AgentProcess, id: string, harness: HarnessId, { onPermission, resumed, unregisterHooks }: SessionSetup) {
    this.agent = agent;
    this.id = id;
    this.harness = harness;
    this.costTotal = resumed ? undefined : 0;
    const detach = agent.attach(id, {
      onUpdate: ({ update }) => {
        if (update.sessionUpdate === "usage_update" && update.cost) this.costTotal = update.cost.amount;
        this.emit({ type: "update", update });
      },
      onPermission: async (request) => {
        this.emit({ type: "permission", request });
        return toPermissionResponse(request, await onPermission(request));
      },
    });
    this.detach = () => {
      detach();
      unregisterHooks?.();
    };
  }

  get running(): boolean {
    return this.run !== undefined;
  }

  prompt(content: string | acp.ContentBlock[]): PromptRun {
    if (this.run) throw new Error(`session ${this.id} already has a prompt running`);
    const prompt: acp.ContentBlock[] = typeof content === "string" ? [{ type: "text", text: content }] : content;
    const run = new PromptRun(() => void this.cancel());
    this.run = run;
    const costBefore = this.costTotal;

    this.agent.request("session/prompt", { sessionId: this.id, prompt }).then(
      (response) => {
        this.run = undefined;
        const result = { stopReason: response.stopReason, usage: toUsage(response, costBefore, this.costTotal), response };
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
    await this.agent.notify("session/cancel", { sessionId: this.id });
  }

  async close(): Promise<void> {
    this.detach();
  }

  private emit(event: HarnessEvent): void {
    this.run?.push(event);
    this.notify(event);
  }

  private notify(event: HarnessEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
