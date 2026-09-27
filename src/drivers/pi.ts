import { HOOKS_META } from "../adapters/pi/bridge.ts";
import type { Driver } from "./types.ts";
import { nodeScript, onPath, siblingScript } from "./util.ts";

const ADAPTER = siblingScript(import.meta.url, "../adapters/pi/main");

/**
 * pi via our own ACP adapter (src/adapters/pi), which runs one `pi --mode rpc`
 * per session and reads `_meta.neoworks` itself, so every option is per session.
 */
export const pi: Driver = {
  id: "pi",
  efforts: ["low", "medium", "high", "xhigh", "max"],
  capabilities: {
    systemPromptReplace: "session",
    systemPromptAppend: "session",
    // pi has no web tools; web_search / web_fetch are dropped.
    tools: "partial",
    model: "session",
    effort: "session",
    isolation: "session",
    // Enforced by a bundled pi extension that asks over ACP.
    permissions: "session",
    limits: "none",
    images: true,
    audio: false,
    resume: true,
    fork: false,
    cost: true,
  },

  async detect() {
    const path = await onPath(process.env.NEOWORKS_PI_COMMAND ?? "pi");
    return path ? { available: true, detail: path } : { available: false, detail: "`pi` not on PATH" };
  },

  async spawn() {
    return nodeScript(ADAPTER);
  },

  sessionMeta(_options, context) {
    // The adapter reads `_meta.neoworks` itself; hooks only need the bridge.
    return context.hooks && { [HOOKS_META]: context.hooks };
  },
};
