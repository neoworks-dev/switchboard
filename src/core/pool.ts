import { AgentProcess, type SpawnSpec } from "./agent-process.ts";

/**
 * Agent processes keyed by their exact spawn spec. Harnesses that only accept
 * config at spawn time (Codex, Gemini, pi) get one process per distinct config;
 * harnesses with per-session config (Claude) naturally share one.
 */
export class ProcessPool {
  private readonly processes = new Map<string, Promise<AgentProcess>>();

  acquire(spec: SpawnSpec): Promise<AgentProcess> {
    const key = specKey(spec);
    const existing = this.processes.get(key);
    if (existing) {
      return existing.then(
        (agent) => (agent.alive ? agent : this.startFresh(key, spec)),
        () => this.startFresh(key, spec),
      );
    }
    return this.startFresh(key, spec);
  }

  /** Kill processes with no attached sessions. */
  reap(): void {
    for (const [key, pending] of this.processes) {
      void pending.then((agent) => {
        if (agent.sessionCount === 0 && this.processes.get(key) === pending) {
          this.processes.delete(key);
          agent.kill();
        }
      }, () => this.processes.delete(key));
    }
  }

  async close(): Promise<void> {
    const all = [...this.processes.values()];
    this.processes.clear();
    for (const pending of all) {
      await pending.then((agent) => agent.kill(), () => {});
    }
  }

  private startFresh(key: string, spec: SpawnSpec): Promise<AgentProcess> {
    const started = AgentProcess.start(spec);
    this.processes.set(key, started);
    started.catch(() => {
      if (this.processes.get(key) === started) this.processes.delete(key);
    });
    return started;
  }
}

function specKey(spec: SpawnSpec): string {
  const env = Object.entries(spec.env ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([spec.command, spec.args, env]);
}
