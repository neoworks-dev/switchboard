import type * as acp from "@agentclientprotocol/sdk";
import type { AgentProcess, SpawnSpec } from "../core/agent-process.ts";
import type { HookName } from "../hooks/types.ts";
import type { Capabilities, Effort, HarnessId, SessionOptions } from "../types.ts";

export type Detection = { available: boolean; detail?: string };

/** Where hook calls go, and which hooks the app registered. */
export type HookBridge = { address: string; hooks: HookName[] };

/** Session facts beyond `SessionOptions` that drivers may need. */
export type DriverContext = { cwd: string; hooks?: HookBridge };

/**
 * Translates harness-neutral `SessionOptions` into what one harness understands:
 * spawn-time config (command/args/env) and/or per-session adapter `_meta`.
 */
export type Driver = {
  id: HarnessId;
  capabilities: Capabilities;
  /** Effort levels worth offering in a picker; the rest map to the nearest one. */
  efforts: readonly Effort[];
  detect(): Promise<Detection>;
  /** Everything that can only be set at process start. Equal specs share a process. */
  spawn(options: SessionOptions, context: DriverContext): Promise<SpawnSpec>;
  /** Adapter `_meta` for session/new, load and resume. Re-sent on every call. */
  sessionMeta(options: SessionOptions, context: DriverContext): Record<string, unknown> | undefined;
  /** MCP servers the driver adds to the app's, e.g. for hashline edits. */
  mcpServers?(options: SessionOptions, context: DriverContext): acp.McpServer[];
  /** Post-creation setup that has no `_meta` form (e.g. `session/set_mode`). */
  configure?(
    agent: AgentProcess,
    sessionId: string,
    modes: acp.SessionModeState | undefined,
    options: SessionOptions,
  ): Promise<void>;
};
