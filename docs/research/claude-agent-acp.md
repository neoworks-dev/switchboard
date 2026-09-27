# claude-agent-acp capabilities

Source: `@agentclientprotocol/claude-agent-acp` 0.81.2 (commit e6681d2, 2026-09-25), on `@anthropic-ai/claude-agent-sdk` 0.3.280 and `@agentclientprotocol/sdk` 1.5.0.
`A:` = `src/acp-agent.ts`, `D:` = SDK `sdk.d.ts`.

**Key fact:** `_meta.claudeCode.options` is spread almost verbatim into SDK `Options` (A:8315, 8441-8588). Nearly any JSON-serialisable SDK option is reachable; function-valued ones (hooks callbacks, canUseTool) are not. Read on session/new, load, resume (A:2394, 2417, 2431) — not fork. Adapter always overrides `cwd`, `includePartialMessages`, `permissionMode`, `canUseTool`, `forwardSubagentText`, `abortController`; drops `agent` (A:8321).

| Feature | ACP std | Adapter `_meta` / `_` methods | Native-only | Evidence |
|---|---|---|---|---|
| Replace system prompt | no | `_meta.systemPrompt: string` or `_meta.claudeCode.options.systemPrompt` (also `string[]`; wins, spread later) | — | A:8278-8296, 8441-8445 |
| Append system prompt | no | `_meta.systemPrompt: {append?, excludeDynamicSections?, …}` (forced preset claude_code) | — | A:8283-8294; D:2330 |
| Restrict/disable tools | no | `options.tools` (array/preset), legacy `_meta.disableBuiltInTools: true`, `options.allowedTools`; `options.disallowedTools` merged | — | A:8350-8352, 8487 |
| Model | config option `model` via `session/set_config_option` | `options.model`, `options.fallbackModel`; env `CLAUDE_MODEL_CONFIG` | — | session-model.ts:5; A:10548-10580 |
| Thinking/effort | config options `effort`, `fast` | `options.effort`, `options.thinking`, `options.maxThinkingTokens`; env `MAX_THINKING_TOKENS` | runtime `setMaxThinkingTokens` | A:8328, 8756-8773, 9321 |
| MCP | honours `mcpServers` stdio/http/sse; advertises `mcpCapabilities{http,sse}` | `options.mcpServers` merged (ACP wins on clash); MCP OAuth via URL elicitation | `setMcpServers`, `toggleMcpServer`, in-process SDK servers | A:8252-8276, 2347, 8456, 1973 |
| Isolation | no | `options.settingSources` (default user,project,local), `options.strictMcpConfig`, `options.settings`, `options.managedSettings` | — | A:8443, 8396-8421 |
| Permissions | `session/request_permission`; modes default/acceptEdits/plan/auto/bypassPermissions | `RequestPermissionRequest._meta.permission{version:1,title,description}`; `options.allowDangerouslySkipPermissions:false`; AskUserQuestion → form elicitation | `permissionMode` in `_meta` ignored | A:8304-8313, 8460-8461; session-mode.ts:318-344 |
| Load/resume/fork/list/close/delete | all advertised | fork point `_meta.jetbrains.air.fork{version:1,messageId,…}`; legacy resume via new + `options.resume` | `resumeSessionAt`, `renameSession`/`tagSession` | A:2320-2328, 2392-2462; fork-session.ts:178-235 |
| Cancel | `session/cancel`, `$/cancel_request` | — | — | A:6467, 10515 |
| Content | image (base64/URL), text resource, resource_link; `promptCapabilities{image,embeddedContext}` | — | audio & blob silently dropped | A:9555-9620, 2343 |
| Usage/cost | `PromptResponse.usage`; `usage_update{used,size,cost}` | response `_meta.quota{token_count,model_usage[]}`; `usage_update._meta["_claude/model"|"_claude/origin"|"_claude/rateLimit"]` | — | A:9005-9055, 5302-5318, 3575, 6337 |
| Subagents | draft `subagent_spawned`/`subagent_state_update` (needs `clientCapabilities.subagents`) | `_meta.jetbrains.air.capabilities:["nativeSubagentSessions"]`; legacy `clientCapabilities._meta["subagent-transcript"]`; tool `_meta.claudeCode{subagent,parentToolUseId}` | — | acp-subagents.ts; A:1447-1506, 8322 |
| Hooks | no | `options.hooks` merged but callbacks can't cross JSON; shell hooks via `options.settings`; `options.includeHookEvents` | SDK callback hooks | A:8489-8584 |
| Slash commands/skills | `available_commands_update` | `/mcp:srv:cmd` rewrite; `options.skills`; Skill tool `_meta.claudeCode{skill,skillPath}` | `reloadSkills` | A:7738, 9563, 1476-1481 |
| Modes | `modes` + `current_mode_update`; config option `mode` | — | — | session-mode.ts:22 |
| Plan | `plan` from TodoWrite/TaskCreated | — | — | A:3158, 10040 |
| Structured output | no | `options.outputFormat` accepted; result only via `claudeCode.emitRawSDKMessages` → `_claude/sdkMessage` | yes | A:1374-1380, 4226, 5660 |
| Max turns/budget | stopReason `max_turn_requests` | `options.maxTurns`, `options.maxBudgetUsd`, `options.taskBudget` | — | A:5632-5672 |
| cwd/extra dirs | `cwd` (absolute, must exist), `additionalDirectories` | `_meta.additionalRoots` (legacy), `options.additionalDirectories` | — | A:8160, 8363-8368 |
| Env | no | `options.env` over `process.env` | — | A:8422-8431 |
| Auth | terminal authMethods, `logout`, unstable `providers/*` | `authenticate` `_meta.gateway{baseUrl,headers}`; `_meta.claudeCode.vertex`; `_auth/status_update` | — | A:2203-2318, 2476, 2749 |
| Extras | — | `_session/steering`, `_session/goal`, `_session/async_task/stop`; AIR `asyncTasks`, `sessionFailure`, file-change report; `promptQueueing` | `rewindFiles`, `getContextUsage` | A:2330-2389, 10566-10580; air-extension.ts |

## Gotchas
1. `_meta` is stateless per call — every load/resume must resend systemPrompt/tools/settingSources or defaults return (A:2396).
2. load/resume on a live session: fingerprint (cwd, mcpServers, dirs, `_meta`) match → silent no-op; differ → Query torn down and respawned (A:1315-1340, 8112-8128). `hooks`, `permissionMode` never trigger respawn (A:1214-1288).
3. Fork copies transcript on disk only; ignores `mcpServers`/`_meta`; must load/resume the fork with full `_meta`.
4. Preset prompt recomputed per process start — resume prompt = that call's `_meta` (inferred).
5. `_meta.systemPrompt` as `string[]` silently ignored; use `options.systemPrompt`.
6. `settingSources: []` not full isolation — adapter's SettingsManager still reads `~/.claude/settings.json`, project settings, managed settings for `defaultMode`, `availableModels`, effort (settings.ts:92-99).
7. Initial permission mode only from settings `defaultMode`; set via `set_mode`/`set_config_option` after creation. Root without `IS_SANDBOX` disables bypass.
8. `AskUserQuestion` disabled unless client advertises form elicitation (A:8344).
9. Audio/blob resources dropped without error.
10. `usage_update.cost.amount` = SDK `total_cost_usd` (likely cumulative); `model_usage` includes subagent spend.
11. maxTurns, maxBudgetUsd, structured-output retry exhaustion all → `max_turn_requests`; indistinguishable.

## Hooks and tool switches (Agent SDK 0.3.280 / CLI 2.1.280)

- `options.settings` is the "flag settings" layer and loads even with `settingSources: []`, hooks included (only `disableAllHooks` / managed `allowManagedHooksOnly` stop them). The adapter adds only its own PostToolUse and task hooks.
- ACP session id = Claude `session_id` in hook input, except after the ExitPlanMode "clear context" restart.
- PreToolUse `permissionDecision: "allow"` skips `canUseTool`, i.e. the ACP permission prompt, unless a deny/ask rule matches. So our hooks never answer allow. `updatedInput` without a decision: behaviour not yet verified against a real run.
- `disallowedTools` is merged with the adapter's own (`AskUserQuestion` unless form elicitation). The adapter adds no MCP server of its own; file tools are the native ones.
- Feature switches: `disableWorkflows`, `workflowKeywordTriggerEnabled`, `todoFeatureEnabled`, `disableBundledSkills`, `autoMemoryEnabled` (settings); `CLAUDE_CODE_DISABLE_CRON`, `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`, `ENABLE_TOOL_SEARCH` (env, via `options.env`).
