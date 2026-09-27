/**
 * Contract between our pi extension (extension.ts, runs inside pi) and the
 * ACP adapter. Permission questions go through `ctx.ui.confirm(PERMISSION_TITLE, json)`,
 * which pi forwards over RPC as an `extension_ui_request`. Hooks go straight
 * to the backend's HookServer.
 */

export const PERMISSION_TITLE = "neoworks/permission";

/** Env var carrying the policy into pi; unset means the extension allows everything. */
export const PERMISSION_POLICY_ENV = "NEOWORKS_PI_PERMISSIONS";

/** `session/new` and `session/resume` `_meta` key carrying the session's `HookBridge`. */
export const HOOKS_META = "neoworksHookBridge";

/** Env vars naming the hooks to run and the HookServer to ask. */
export const HOOKS_ENV = "NEOWORKS_HOOKS";
export { HOOK_SOCKET_ENV } from "../../hooks/wire.ts";

export type BridgedPolicy = "ask" | "auto-edit";

export type PermissionQuestion = { toolCallId: string; toolName: string; input: unknown };

/** pi tools that only read, built-in or ours. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls", "hashline_read"]);

const EDIT_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "hashline_edit"]);

export function needsApproval(policy: BridgedPolicy, toolName: string): boolean {
  if (READ_ONLY_TOOLS.has(toolName)) return false;
  return policy === "ask" || !EDIT_TOOLS.has(toolName);
}
