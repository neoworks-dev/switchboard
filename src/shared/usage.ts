import type * as acp from "@agentclientprotocol/sdk";
import type { Usage } from "../types.ts";

/**
 * Per-turn usage. Prefers an adapter's own `_meta.neoworks.costUsd`; otherwise
 * derives cost from cumulative `usage_update`s, which needs a known baseline.
 */
export function toUsage(response: acp.PromptResponse, costBefore?: number, costAfter?: number): Usage | undefined {
  const usage = response.usage;
  const reported = (response._meta?.neoworks as { costUsd?: unknown } | undefined)?.costUsd;
  const derived = costBefore !== undefined && costAfter !== undefined ? costAfter - costBefore : undefined;
  const costUsd = typeof reported === "number" ? reported : derived;
  if (!usage && costUsd === undefined) return undefined;
  return {
    input: usage?.inputTokens,
    output: usage?.outputTokens,
    cacheRead: usage?.cachedReadTokens ?? undefined,
    cacheWrite: usage?.cachedWriteTokens ?? undefined,
    costUsd,
  };
}
