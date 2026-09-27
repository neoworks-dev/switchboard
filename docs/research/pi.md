# pi capabilities (ACP adapters vs native)

Versions: pi `2b0a123` (`@earendil-works/pi-coding-agent` 0.87.1) · svkozak/pi-acp `b0581c9` (`pi-acp` 0.0.34) · georgeharker/pi-acp `03fe96c` (`@geohar/pi-acp` 0.3.2) · bkonkle/pi-acp `190c70d` (fork of gh, publishes `@geohar/pi-acp` 0.3.1) · victor-software-house/pi-acp `0ef24b2` (0.17.1, pins pi `^0.75.3`, inactive since 2026-06-08).
Short: **sv**, **gh**, **bk**, **vic**. Pi paths relative to `packages/coding-agent`; `rpc-types` = `src/modes/rpc/rpc-types.ts`.

**Verdict:** no adapter lets an ACP client set system prompt, tools, provider/auth, env or isolation per session; none reads request `_meta` except vic's manifest. All exist natively as CLI flags / SDK options → **write a native driver over `pi --mode rpc`** (or embed SDK), using gh as reference.

| Feature | ACP std (per adapter) | Adapter `_meta` | Pi-native + how | Evidence |
|---|---|---|---|---|
| Replace system prompt | none | none | `--system-prompt <text\|path>`; SDK `DefaultResourceLoader{systemPrompt, systemPromptOverride}`; extension `before_agent_start` returns `systemPrompt`. No RPC command | cli.md:183; resource-loader.ts:230,248; extensions.md:101 |
| Append system prompt | none | none | `--append-system-prompt` (repeatable); SDK `appendSystemPrompt[]` | cli.md:185 |
| Restrict tools | none | none | `--tools`, `-xt`, `-nbt`, `-nt`; SDK `tools/noTools/excludeTools/customTools`, `session.setActiveToolsByName()`. No RPC | cli.md:118-124; agent-session.ts:1282 |
| Model/provider | all: configOption `model` + `unstable_setSessionModel`; vic `providers/*` | none | RPC `set_model{provider,modelId}`, `get_available_models`; `--provider/--model/--api-key` | rpc-types:33-35 |
| Thinking | all: configOption `thought_level` (also abused as session modes) | none | RPC `set_thinking_level`; `--thinking` | sv agent.ts:1160-1172 |
| MCP | sv/vic: accepted, ignored. gh/bk: stdio+http → temp file `--mcp-config` for **pi-mcp-adapter** extension (must be installed) | none | pi has no MCP; `pi-mcp-adapter` extension | gh process.ts:203-205 |
| Isolation | none (all pass `process.env`, load `~/.pi`) | vic `_meta.piAcp.manifest` | `PI_CODING_AGENT_DIR`, `-ne -ns -np -nc --no-themes --no-approve --no-session/--session-dir --offline`; SDK `SettingsManager.inMemory()` | env-vars.md:81-82 |
| Permissions | only via extension `confirm`/`select` dialogs → `request_permission` (sv/gh/bk) | none | extension `tool_call` handler can block; `ctx.ui.confirm` → RPC `extension_ui_request/response` | security.md:3; extensions.md:103 |
| Load/resume/fork | sv: load/list/delete; gh/bk: +resume/close; vic: +fork | none | RPC `switch_session`, `fork{entryId}`, `clone`, `get_tree`, `new_session{parentSession}` | rpc-types:61-66 |
| Cancel | `session/cancel` → `abort` | none | RPC `abort`, `abort_bash`, `abort_retry` | sv session.ts:397-416 |
| Images | `promptCapabilities.image` | none | RPC `prompt.images[]` (base64 + mimeType) | rpc-commands.md:17 |
| Cost/tokens | sv: `usage_update{used,size}`; bk: + cost; vic: usage + `_meta.cost` | vic `PromptResponse._meta.cost` | RPC `get_session_stats` → `{tokens{input,output,cacheRead,cacheWrite,total},cost,contextUsage}` | bk session.ts:531-557 |
| Subagents | gh/bk: pi-subagents fleet as `plan` entries | `plan.entries[]._meta.piAcp{section:"agents",subagent{…}}` | none in core; `@tintinweb/pi-subagents` | bk subagent-plan.ts:186-194 |
| Extensions | dialogs bridged | `session_info_update._meta.piAcp.notify{level}` | `-e <path>`, SDK inline extensions | bk process.ts:28-38 |
| Commands/skills | `available_commands_update` | none | `-np/-ns/--skill/--prompt-template`; RPC `get_commands` | sv agent.ts:63-104 |
| Steering | adapter-side queue only | `session_info_update._meta.piAcp{queueDepth,running}` | RPC `steer`, `follow_up`, `prompt.streamingBehavior`, `clear_queue` | rpc-commands.md:20-30 |
| Structured output | none | none | not in pi; custom tool + `get_last_assistant_text` | — |
| cwd | spawn cwd | vic manifest `mode` | spawn cwd; SDK `cwd` | sv process.ts:166 |
| env | none | none | spawn env only | gh process.ts:234 |
| Auth | terminal login | `authMethods._meta["terminal-auth"]` | OAuth (Claude Pro/Max, ChatGPT Plus/Pro, Copilot, xAI, Kimi, Meta) in `auth.json`; API keys; `pi auth check --json` | providers.md |

## Gotchas
- sv and gh kill other sessions on new/load (`closeAllExcept`); bk and vic don't.
- Adapters queue mid-turn prompts themselves; pi's real steering never reaches ACP clients.
- RPC mode skips project `.pi/` extensions/settings unless `--approve` or saved trust; AGENTS.md/CLAUDE.md load unless `-nc`.
- bk `PromptResponse.usage` = running session total.
- RPC: `prompt` during streaming errors unless `streamingBehavior` set; wait for `agent_settled`, not `agent_end`.
- Don't parse RPC output with Node `readline` — splits on U+2028/U+2029.
- gh README contradicts itself on MCP; source uses temp file.
- Thinking levels occupy the ACP modes slot.
- Unknown `--flags` pass through to extensions (how `--mcp-config` works).
