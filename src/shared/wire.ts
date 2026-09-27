/**
 * What the sidecar adds to plain ACP. Everything else on the wire is standard
 * ACP: initialize, session/new, resume, prompt, cancel, close, session/update
 * and session/request_permission.
 */
import type { HookName } from "../hooks/types.ts";
import type { HarnessId } from "../options.ts";

export const METHODS = {
  /** client → sidecar: `HarnessInfo[]` */
  harnesses: "_neoworks/harnesses",
  /** client → sidecar, `{ harness }`: `ModelInfo[]` */
  models: "_neoworks/models",
  /** sidecar → client, `{ sessionId, hook, event }`: the hook's output, or null */
  hook: "_neoworks/hook",
} as const;

/**
 * `_meta` key on session/new and session/resume, next to `neoworks` (the
 * `SessionOptions`): which harness to run, and which hooks the client handles.
 */
export const SESSION_META = "neoworksSession";

export type SessionMeta = { harness?: HarnessId; hooks?: HookName[] };

export type HookRequest = { sessionId: string; hook: HookName; event: unknown };
