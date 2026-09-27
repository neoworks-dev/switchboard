import { join } from "node:path";
import type { Driver } from "../../src/drivers/types.ts";
import { runnerCommand } from "../../src/hooks/command-hooks.ts";
import type { HarnessEvent } from "../../src/types.ts";

export const FAKE_AGENT = join(import.meta.dir, "fake-agent.ts");

/** A "claude" driver that runs fake-agent.ts, one process per model name. */
export const fakeDriver: Driver = {
  id: "claude",
  capabilities: {} as Driver["capabilities"],
  efforts: ["low"],
  detect: async () => ({ available: true }),
  spawn: async (options) => ({
    command: process.execPath,
    args: [FAKE_AGENT],
    env: { FAKE_TAG: options.model ?? "default" },
  }),
  sessionMeta: (options, context) => ({
    driverSaw: options.tools === "none" ? "no-tools" : undefined,
    hookCommand: context.hooks && runnerCommand("claude", context.hooks.address)("beforeToolUse"),
  }),
};

export type Collected = { text: string; done?: HarnessEvent & { type: "done" }; permissions: number };

/** Drain a prompt's events into its text, permission count and final event. */
export async function collect(events: AsyncIterable<HarnessEvent>): Promise<Collected> {
  const collected: Collected = { text: "", permissions: 0 };
  for await (const event of events) {
    if (event.type === "update" && event.update.sessionUpdate === "agent_message_chunk" && event.update.content.type === "text") {
      collected.text += event.update.content.text;
    }
    if (event.type === "permission") collected.permissions++;
    if (event.type === "done") collected.done = event;
  }
  return collected;
}
