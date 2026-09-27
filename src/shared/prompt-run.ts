import type { HarnessEvent, PromptResult, PromptRun as PromptRunContract } from "../types.ts";

/**
 * A prompt turn as both an event stream and a promise. The producer pushes
 * events and settles it; any number of consumers iterate from the start or
 * await the result.
 */
export class PromptRun implements PromptRunContract {
  private readonly events: HarnessEvent[] = [];
  private readonly waiters = new Set<() => void>();
  private readonly result: Promise<PromptResult>;
  private resolveResult!: (result: PromptResult) => void;
  private rejectResult!: (error: unknown) => void;
  private settled = false;
  private failure?: { error: unknown };
  private readonly onAbandon: () => void;

  /** `onAbandon` runs when a consumer stops iterating before the turn ended. */
  constructor(onAbandon: () => void) {
    this.onAbandon = onAbandon;
    this.result = new Promise((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
    // Streaming-only consumers never await; a failure then surfaces through iteration.
    this.result.catch(() => {});
  }

  get done(): boolean {
    return this.settled;
  }

  push(event: HarnessEvent): void {
    if (this.settled) return;
    this.events.push(event);
    this.wakeAll();
  }

  finish(result: PromptResult): void {
    if (this.settled) return;
    this.events.push({ type: "done", ...result });
    this.settled = true;
    this.resolveResult(result);
    this.wakeAll();
  }

  fail(error: unknown): void {
    if (this.settled) return;
    this.settled = true;
    this.failure = { error };
    this.rejectResult(error);
    this.wakeAll();
  }

  // Thenable on purpose: `await session.prompt(...)` is the non-streaming API.
  // oxlint-disable-next-line unicorn/no-thenable
  then<A = PromptResult, B = never>(
    onFulfilled?: ((result: PromptResult) => A | PromiseLike<A>) | null,
    onRejected?: ((error: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    return this.result.then(onFulfilled, onRejected);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<HarnessEvent> {
    let index = 0;
    try {
      while (true) {
        const event = this.events[index];
        if (event) {
          index++;
          yield event;
          if (event.type === "done") return;
          continue;
        }
        if (this.failure) throw this.failure.error;
        await new Promise<void>((resolve) => this.waiters.add(resolve));
      }
    } finally {
      if (!this.settled) this.onAbandon();
    }
  }

  private wakeAll(): void {
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }
}
