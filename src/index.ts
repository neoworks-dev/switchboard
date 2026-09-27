/**
 * `@neoworks/harness`: drive Claude Code, Codex and pi from one API.
 *
 * - `Harness` runs the harnesses as child processes of this (Node) process.
 * - `serve` puts a `Harness` behind a WebSocket for `HarnessClient`
 *   (`@neoworks/harness/client`), e.g. from a sandboxed Electron renderer.
 */
export { createHarness, Harness, loadConfig, CONFIG_PATH, type HarnessConfig } from "./core/harness.ts";
export { Session, rejectPermission } from "./core/session.ts";
export { serve, type ServeOptions, type Sidecar } from "./server/serve.ts";
export { serveConnection } from "./server/connection.ts";
export type { Driver, Detection } from "./drivers/types.ts";
export type * from "./types.ts";
export type {
  ContentBlock,
  McpServer,
  RequestPermissionRequest,
  SessionUpdate,
  StopReason,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
