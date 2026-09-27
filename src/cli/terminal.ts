import { createInterface } from "node:readline/promises";
import type * as acp from "@agentclientprotocol/sdk";
import type { HarnessEvent } from "../types.ts";

/** Assistant text to stdout; everything else to stderr so stdout stays pipeable. */
export function printEvent(event: HarnessEvent): void {
  switch (event.type) {
    case "update":
      printUpdate(event.update);
      break;
    case "done": {
      const usage = event.usage ? ` ${JSON.stringify(event.usage)}` : "";
      process.stdout.write("\n");
      console.error(`[done: ${event.stopReason}${usage}]`);
      break;
    }
  }
}

function printUpdate(update: acp.SessionUpdate): void {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      if (update.content.type === "text") process.stdout.write(update.content.text);
      break;
    case "tool_call":
      console.error(`\n[tool ${update.kind ?? "other"}: ${update.title}]`);
      break;
    case "tool_call_update":
      if (update.status === "failed") console.error(`[tool ${update.toolCallId} failed]`);
      break;
    case "plan":
      console.error(`[plan: ${update.entries.map((entry) => entry.content).join(" | ")}]`);
      break;
  }
}

export function approveAll(request: acp.RequestPermissionRequest): acp.RequestPermissionResponse {
  const allow = request.options.find((option) => option.kind === "allow_once") ?? request.options[0];
  return allow ? selected(allow.optionId) : { outcome: { outcome: "cancelled" } };
}

export async function askOnTerminal(request: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    console.error(`\n[permission] ${request.toolCall.title ?? request.toolCall.toolCallId}`);
    request.options.forEach((option, index) => console.error(`  ${index + 1}) ${option.name}`));
    const choice = request.options[Number(await rl.question("> ")) - 1];
    return choice ? selected(choice.optionId) : { outcome: { outcome: "cancelled" } };
  } finally {
    rl.close();
  }
}

function selected(optionId: string): acp.RequestPermissionResponse {
  return { outcome: { outcome: "selected", optionId } };
}
