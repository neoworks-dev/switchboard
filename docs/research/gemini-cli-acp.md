# Gemini CLI native ACP capabilities

Source: gemini-cli commit `2fe7c2d` (2026-09-25), `0.63.0-nightly.20260923`, `@agentclientprotocol/sdk` 0.16.1. ACP code in `packages/cli/src/acp/` (paths relative to it unless noted). Launch: `gemini --acp` (`--experimental-acp` deprecated, `packages/cli/src/config/config.ts:363-370`).

`initialize` advertises (`acpRpcDispatcher.ts:199-218`): `loadSession: true`; prompt caps image/audio/embeddedContext; `mcpCapabilities {http, sse}`; 4 auth methods. Implemented: `authenticate`, `session/new`, `session/load`, `session/prompt`, `session/cancel`, `session/set_mode`, `unstable_setSessionModel`. No list/resume/fork/close/`set_config_option`, no custom `_` methods.

| Feature | ACP std | _meta / custom | Native-only + how | Evidence |
|---|---|---|---|---|
| Replace system prompt | no | no | `GEMINI_SYSTEM_MD=<path>` or `=true` (`.gemini/system.md` vs **process** cwd); GEMINI.md + skills still appended | core `prompts/promptProvider.ts:53,111-119` |
| Append system prompt | no | no | none; GEMINI.md, `context.fileName`, `--include-directories` | `settingsSchema.ts:1386+` |
| Restrict tools | no | no | settings `tools.core` / `tools.exclude`, `--policy`; `--allowed-tools` only auto-approves; `ask_user` always excluded in ACP | `config.ts:791-806,979-984` |
| Model | `unstable_setSessionModel`; `models{availableModels,currentModelId}` in new/load | – | `--model`, `GEMINI_MODEL`, `model.name` | `acpSessionManager.ts:147-161`, `acpSession.ts:237` |
| Thinking budget | no (thoughts stream as `agent_thought_chunk`) | no | `modelConfigs.customOverrides`/`customAliases` → `thinkingConfig.thinkingBudget` | `docs/cli/generation-settings.md:140-190` |
| MCP | yes: stdio (env; cwd=session cwd), http, sse (headers) | – | settings `mcpServers`; ACP merged over settings, same name overrides | `acpSessionManager.ts:292-331` |
| Isolation | no | no | `GEMINI_CLI_HOME` (moves ~/.gemini: settings, GEMINI.md, extensions, OAuth, chats), `GEMINI_CLI_SYSTEM_SETTINGS_PATH`, `-e none`, `GEMINI_CLI_TRUST_WORKSPACE=false` | core `utils/paths.ts:23`, `settings.ts:107`, `extensionEnablement.ts:147` |
| Approval mode | `session/set_mode` ids `default`/`autoEdit`/`yolo`/`plan` | – | `--approval-mode default\|auto_edit\|yolo\|plan`, `--yolo` | `acpUtils.ts:224-252` |
| request_permission | yes; option ids `proceed_once`, `proceed_always`, `proceed_always_and_save`, `proceed_always_server`, `proceed_always_tool`, `cancel`; diff `_meta.kind: add\|delete\|modify` | diff `_meta.kind` | – | `acpUtils.ts:85-200`, `acpSession.ts:726-790` |
| Load/resume | `session/load` replays history | – | `--resume`, `--session-id`, `--list-sessions` | `acpSessionManager.ts:166-235` |
| Cancel | `session/cancel` → `cancelled` | – | – | `acpSession.ts:198-205` |
| Content | image, audio → inlineData; `file://` resource_link → `@path`; other URIs → text `@uri`; embedded resource ok | – | – | `acpSession.ts:977-1010` |
| Tokens/cost | no `usage_update` | `PromptResponse._meta.quota{token_count{input_tokens,output_tokens}, model_usage[]}`; no cost/cached/thought | `-o stream-json` result `stats` | `acpSession.ts:360-627` |
| Subagents | tool_call kind `think` only; inner steps not streamed | – | `agents` setting, `.gemini/agents` | `acpUtils.ts:215` |
| Hooks | – | – | settings `hooks` (see gotcha 1) | `settingsSchema.ts:2595` |
| Slash commands | `available_commands_update`, built-ins only (`/memory /extensions /init /restore /about /help`) | – | custom `.toml` commands not exposed | `acpCommandHandler.ts:23-31` |
| Modes | yes (= approval modes) | agent-side changes as text `[MODE_UPDATE] <mode>`, not `current_mode_update` | – | `acpSession.ts:170-180` |
| Plan | no `plan`; `write_todos` only as tool_call | – | – | absent |
| Structured output | no | no | none; `-o json` = `{response, stats}` | `config.ts:467` |
| cwd | `session/new` cwd; workspace settings reloaded per cwd | – | – | `acpSessionManager.ts:63` |
| env | no | no | process env at spawn only | – |
| Auth | `oauth-personal`, `gemini-api-key`, `vertex-ai`, `gateway` | `_meta["api-key"]`, `_meta.gateway{baseUrl?,headers?}` | `GEMINI_API_KEY`, Vertex env, `GOOGLE_GEMINI_BASE_URL` | `acpRpcDispatcher.ts:163-283` |

## Gotchas
1. Tool hooks + SessionStart don't fire in ACP: tools run via `invocation.execute()` directly (`acpSession.ts:854`), bypassing `coreToolHookTriggers.ts:68`; ACP exits before `fireSessionStartEvent` (`gemini.tsx:874` vs `:945`). BeforeAgent/AfterAgent/BeforeModel likely fire (untested).
2. `authenticate` writes `security.auth.selectedType` to `~/.gemini/settings.json` and clears cached creds on change — use `GEMINI_CLI_HOME`.
3. `session/new` without auth defaults to `gemini-api-key` → `-32000` if no key. `session/load` returns `authRequired`.
4. `session/load` uses startup settings, not `loadSettings(cwd)`; lookup scoped to project storage of that cwd.
5. input_tokens summed over every model call in a prompt (history recounted); 0 for slash commands; empty/blocked streams still `end_turn`.
6. cancel with nothing running throws "Not currently generating" (swallowed, it's a notification); pending `request_permission` must be answered `cancelled`.
7. `mcp.allowed` / `--allowed-mcp-server-names` silently filter ACP-supplied servers. CLI waits for all MCP servers before each prompt.
8. Client `fs` used only inside session cwd and outside ~/.gemini; client terminal capability never used.
9. `docs/cli/acp-mode.md` stale.
10. Untrusted folder → workspace `.gemini/settings.json` not applied; `--skip-trust` sets `GEMINI_CLI_TRUST_WORKSPACE=true`.
11. Non-ACP settings: per-process via spawn env/flags; per-session only via workspace `.gemini/settings.json` under session cwd (needs trust).
12. Unverified: whether subagent tool approvals ("ask user") ever reach client as `request_permission` (`acpSession.ts:97-165`).
