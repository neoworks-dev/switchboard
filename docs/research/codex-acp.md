# codex-acp capabilities

**Canonical adapter:** `agentclientprotocol/codex-acp`, npm `@agentclientprotocol/codex-acp` 1.13.1 (commit bf37821, 2026-09-25). TypeScript; spawns `codex app-server` (JSON-RPC) as child; bundles `@openai/codex` ^0.156.1 (installed 0.156.1).
**Not** `@zed-industries/codex-acp` — old Rust adapter (0.16.0), repo archived 2026-07-22, npm still serves it.
Codex: `openai/codex` 88235f8 (2026-09-27); `@openai/codex-sdk` 0.157.1.
Paths: **A** = codex-acp `src`, **C** = codex `codex-rs`, **S** = codex `sdk/typescript/src`.

**Only general config hook:** env `CODEX_CONFIG` (JSON object) → passed as `config` override on every `thread/start`/resume/fork (A/index.ts, A/CodexAcpClient.ts:827). Any config.toml key settable, but **per process**, not per session.

| Feature | ACP std | Adapter `_meta` / `_` methods | Native-only + how | Evidence |
|---|---|---|---|---|
| Replace system prompt | no | no | `thread/start.baseInstructions`; config `instructions`/`model_instructions_file` (adapter: only via `CODEX_CONFIG`) | C/app-server-protocol/src/protocol/v2/thread.rs:100; C/core/src/config/mod.rs:3987 |
| Developer instructions | no | no | `thread/start.developerInstructions`; config `developer_instructions` | thread.rs:102; config_toml.rs:251 |
| Disable tools | no | no | `features.shell_tool=false`; `web_search="disabled"`; `thread/start.environments: []` removes shell + apply_patch; apply_patch alone follows model catalog `apply_patch_tool_type` | C/core/src/tools/spec_plan.rs:1084,1269,1484 |
| Model | config option `model` (`model[effort]`); legacy `session/set_model` | — | `thread/start.model`, `turn/start.model`, `-m` | A/ModelConfigOption.ts:6; A/ModelId.ts |
| Reasoning effort | config option `reasoning_effort` | — | `turn/start.effort`; `model_reasoning_effort` | A/CodexAcpClient.ts:1035 |
| MCP | yes on new/load/resume/fork; stdio + http; sse/acp rejected | `_meta.mcpStartupAwaitTimeoutMs` (number) on new/resume/fork | — | A/CodexAcpClient.ts:833-930; A/CodexAcpServer.ts:3542 |
| Isolation | no | no | env `CODEX_HOME` at adapter launch (also moves auth); `--ignore-user-config` only on `codex exec` | C/utils/home-dir/src/lib.rs:13; C/exec/src/cli.rs:40 |
| Approval / sandbox | modes via `session/set_mode` or config option `mode`: `read-only`, `workspace-write`, `agent` (default), `agent-full-access`; request_permission ids `allow_once`, `allow_for_session`, `decline`, `cancel`, `accept_execpolicy_amendment`… | display `_meta.permission{version,title,description}`; `_meta.is_mcp_tool_approval` | arbitrary `approvalPolicy`/`sandboxPolicy`/`approvalsReviewer` on `turn/start` | A/AgentMode.ts; A/permissions/option-ids.ts |
| Load/resume/fork/list/delete/close | yes (fork = unstable `session/fork`) | `_meta.additionalRoots: string[]` | `thread/rollback`, fork at `lastTurnId` | A/index.ts; A/CodexAcpClient.ts:1317 |
| Cancel | `session/cancel` → `turn/interrupt` | `_session/steering {sessionId, prompt}` | — | A/CodexAcpServer.ts:3445 |
| Images | `image` blocks + image `resource` blobs; audio dropped | — | — | A/CodexAcpClient.ts:1234-1262 |
| Tokens/cost | `PromptResponse.usage`; `usage_update{used,size}` | `PromptResponse._meta.quota{token_count, model_usage}` | no cost anywhere; rate limits only via `/status` | A/TokenCount.ts; A/CodexAcpServer.ts:3382 |
| Subagents | draft `subagent_spawned`/`subagent_state_update` (needs `clientCapabilities.subagents`) | `_meta.jetbrains.air.capabilities:["nativeSubagentSessions"]` | off: `features.multi_agent=false` | docs/subagent-sessions.md |
| Hooks | no | no — adapter drops `hook/started`/`hook/completed` | `CODEX_CONFIG.hooks` works (session-flags layer) but needs `hooks.state.<key>.trusted_hash` or `bypass_hook_trust`; also `$CODEX_HOME/hooks.json`; `features.hooks` (default on). PreToolUse fires for every function tool (`Bash` for exec, `apply_patch`, `mcp__server__tool`); rewrites need `permissionDecision: "allow"` + `updatedInput` and leave approval untouched | codex-rs/hooks/src/engine/discovery.rs:129-186, 713-821; events/pre_tool_use.rs |
| Commands/skills | `available_commands_update`: `/plan /mcp /skills /status /review* /compact /goal /rename /logout` + skills | goal method `{sessionId, action}` | custom prompts not exposed | A/CodexCommands.ts:114-179 |
| Plan | `plan` update; plan mode = config option `collaboration_mode=plan` | `_meta.codex.kind="plan_review"` | — | A/CodexEventHandler.ts:1185 |
| Structured output | no | no | `turn/start.outputSchema`; `exec --output-schema FILE`; SDK `run(…, {outputSchema})` | turn.rs; C/exec/src/cli.rs:48; S/thread.ts:74 |
| cwd | yes + `additionalDirectories` (writable roots + skill roots) | `_meta.additionalRoots` | — | A/CodexAcpClient.ts:1329 |
| env | per-MCP-server `env` only | no | app-server inherits adapter env; `shell_environment_policy`; SDK `env` | A/CodexJsonRpcConnection.ts |
| Auth | `authenticate`: `api-key`, `chat-gpt`, `chat-gpt-device-code`, `gateway`; `logout` | `_meta["api-key"].apiKey`; `_meta.gateway{baseUrl,headers,providerName}`; `_auth/status_update`; env `DEFAULT_AUTH_REQUEST` | SDK `apiKey`/`baseUrl` | A/CodexAuthMethod.ts |

## Gotchas
1. Default mode `agent` sets `approvalsReviewer:"auto_review"` — a Codex reviewer model decides approvals; you only see `request_permission` for what it escalates. **Verified on published 1.13.1 (2026-09-27):** modes are only `read-only` (kind `standard` = workspace-write sandbox + user review, i.e. "Ask for approval"), `agent` (`auto_review`), `agent-full-access`; `workspace-write` exists only in newer repo source, and an unknown `INITIAL_AGENT_MODE` silently falls back to `agent`. The driver therefore picks a mode by `_meta.kind` after session/new and calls `session/set_mode` (`pickCodexMode`).
2. Adapter sends its own approval/sandbox settings every turn (A/CodexAcpClient.ts:1031) — `approval_policy`/`sandbox_mode` in config.toml or `CODEX_CONFIG` ignored.
3. Adapter marks every session cwd `projects.<cwd>.trust_level="trusted"` (A/CodexAcpClient.ts:829) → AGENTS.md + project `.codex/config.toml` always loaded. Suppress: `project_doc_max_bytes=0` + separate `CODEX_HOME`.
4. MCP drops: ACP server whose name exists in user config is dropped (user wins; opt out `DISABLE_MCP_CONFIG_FILTERING=true`); any ACP `mcpServers` replaces whole `mcp_servers` from `CODEX_CONFIG` (A/CodexAcpClient.ts:853); spaces in names sanitised.
5. One app-server for all sessions; resuming a still-loaded thread ignores new `config`/`baseInstructions`/`developerInstructions` (only logged) (C/app-server/src/request_processors/thread_processor.rs:214).
6. Adapter opts into `experimentalApi:true` — experimental `thread/start` fields (`dynamicTools`, `environments`) reachable natively.
7. Extras: config option `fast-mode` (on/off); MCP elicitation mapped to ACP elicitation.
