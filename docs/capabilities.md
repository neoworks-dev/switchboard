# Capability matrix & driver strategy

> **Google (2026-09-27):** Gemini CLI now only serves API-key / Vertex / Code Assist Standard+ accounts; personal accounts moved to Antigravity CLI (`agy`), which is closed source and has no native ACP. Google's terms forbid personal Antigravity OAuth through third-party tools. The Gemini column below is kept for reference; a Google driver is deferred.

Synthesis of `docs/research/*.md` (sources read 2026-09-25..27).

Legend: **S** = settable per session over ACP (`_meta` or std) · **P** = only at process spawn (env/flags/config file) → needs one process per distinct config · **N** = only via native interface (not through the adapter) · **–** = not available.

| Feature | Claude (claude-agent-acp) | Codex (codex-acp) | Gemini (`gemini --acp`) | pi (native `--mode rpc`) |
|---|---|---|---|---|
| Replace system prompt | S `_meta.claudeCode.options.systemPrompt` | P `CODEX_CONFIG.instructions` · N `thread/start.baseInstructions` | P `GEMINI_SYSTEM_MD` (GEMINI.md + skills still appended) | P `--system-prompt` |
| Append system prompt | S `_meta.systemPrompt.append` | P `developer_instructions` · N `developerInstructions` | – (only GEMINI.md) | P `--append-system-prompt` |
| Restrict built-in tools | S `options.tools` | P `features.shell_tool`, `web_search`; N `environments: []` | P settings `tools.core`/`tools.exclude` | P `--tools`/`-nt`; SDK runtime |
| Model | S | S | S (`unstable_setSessionModel`) | S (RPC `set_model`) |
| Effort / thinking | S | S | P (`modelConfigs` overrides) | S (RPC `set_thinking_level`) |
| Inject app MCP (http) | S | S (stdio+http; name clash with user config → dropped unless `DISABLE_MCP_CONFIG_FILTERING`) | S (stdio/http/sse; `mcp.allowed` can filter) | P via `pi-mcp-adapter` extension + `--mcp-config` |
| Isolation from user config | S partial (`settingSources: []`, `strictMcpConfig`; adapter still reads `~/.claude/settings.json`) | P `CODEX_HOME` + `project_doc_max_bytes=0` | P `GEMINI_CLI_HOME` (copy OAuth creds in) | P `PI_CODING_AGENT_DIR`, `-ne -ns -np -nc` |
| Permissions → `request_permission` | S (modes via `set_mode`) | S (use `workspace-write`; default `agent` auto-reviews) | S (`set_mode`) | via extension dialogs only |
| Load / resume / fork | S all | S all | load only | N `switch_session`, `fork`, `clone` |
| Images in prompt | S | S | S (+ audio) | S |
| Usage / cost | S tokens + cost | S tokens, no cost | tokens (rough), no cost | N `get_session_stats` tokens + cost |
| Structured output | S accept; result only via raw SDK msgs | N `turn/start.outputSchema` | – | – |
| Steering mid-turn | S `_session/steering` | S `_session/steering` | – | N RPC `steer`/`follow_up` |
| Subagent visibility | S (draft RFD / AIR `_meta`) | S (draft RFD) | – (opaque tool call) | extension only |
| Hooks | S command hooks in `options.settings.hooks` (flag settings load despite `settingSources: []`) | P `CODEX_CONFIG.hooks` + `bypass_hook_trust` | tool hooks don't fire in ACP | S via our extension (`tool_call`, `tool_result`, `input`, `agent_before_settle`) |
| Disable extras | S `disallowedTools`, settings, `options.env` | P feature flags / `tools.*` / `agents.enabled` | – | – (nothing to disable) |
| Hashline edits | S MCP server, Read/Edit disallowed | P MCP server + PreToolUse hook refusing `apply_patch` (no switch removes it) | – | S our pi extension swaps read/edit |

## Driver strategy

| Harness | Driver | Process model |
|---|---|---|
| Claude | generic ACP driver → `claude-agent-acp`; translate `neoworks.*` → `_meta.claudeCode.options` | one process, per-session config; resend `_meta` on every load/resume |
| Codex | generic ACP driver → `@agentclientprotocol/codex-acp` (not `@zed-industries/…`, archived) | **pool keyed by spawn config**: temp `CODEX_HOME`, `CODEX_CONFIG` JSON, `INITIAL_AGENT_MODE=workspace-write`, `DISABLE_MCP_CONFIG_FILTERING=true`. Native app-server driver later if outputSchema/per-thread instructions needed |
| Gemini | generic ACP driver → `gemini --acp` | **pool keyed by spawn config**: temp `GEMINI_CLI_HOME` (+ copied OAuth creds), `GEMINI_SYSTEM_MD`, generated `settings.json` |
| pi | **own ACP adapter** `src/adapters/pi` over `pi --mode rpc` | one pi process per session, so every option is per session; permissions via bundled pi extension; MCP via the user's `pi-mcp-adapter` |

Pattern: **config-keyed process pool** is a core primitive (Codex, Gemini, pi), not a per-driver hack.

## Draft `neoworks` extension vocabulary

Request side — `_meta.neoworks` on `session/new`, `session/load`, `session/resume` (backend persists it and re-sends to adapters on every call):

```ts
type NeoworksSessionMeta = {
  systemPrompt?: { replace?: string; append?: string }
  tools?: "default" | "none" | BuiltinTool[]      // normalized: read | write | edit | shell | web_search | web_fetch
  model?: string
  effort?: "low" | "medium" | "high" | "xhigh" | "max" | "ultracode"   // ultracode: Claude xhigh + workflow orchestration, else xhigh
  isolation?: "full" | "inherit"                 // full = no user config, instructions, MCP, hooks, skills
  permissions?: "ask" | "auto-edit" | "read-only" | "full-access"
  limits?: { maxTurns?: number; maxBudgetUsd?: number }
  disable?: "all" | Feature[]                    // subagents | workflows | todos | scheduling | worktrees | plan_mode
                                                 // | skills | memory | tool_search | images | user_questions
  edits?: "native" | "hashline"                  // hashline: LINE#ID-anchored read/edit tools replace the harness's
  outputSchema?: JSONSchema                      // only where capability says so
}
```

## Hooks

Apps pass `hooks: { beforeToolUse, afterToolUse, onPromptSubmit, onStop }` to `harness.session()`. Each harness runs them natively, so they can block:

```
harness ──command hook──▶ src/hooks/runner.ts ──unix socket──▶ HookServer ──▶ app callback
pi      ──our extension──────────────────────────unix socket──▶ HookServer ──▶ app callback
```

- Hooks only ever deny, rewrite input or add context. They never answer "allow": in Claude Code that skips the permission prompt, so the session's `permissions` policy would stop applying.
- If the backend is gone, the runner prints nothing and the harness carries on.
- Codex hooks outside the user's own config need a trust hash per hook; we set `bypass_hook_trust`, which also runs untrusted hooks from `<cwd>/.codex/`.
- Observing without blocking needs no hook: every `session/update` is on the prompt's event stream.

## Hashline

`src/hashline/` is a TypeScript port of oh-my-pi's hashline mode (Gen 2 format `LINE#ID:text`, MIT, Can Bölük; via @the-agency/pi-hashline-edit, MIT, Josh Mock), with a spec-correct xxHash32 (the pi port's differs from omp's `Bun.hash.xxHash32`) and an overlap check. The same tool definitions are served as an MCP server (Claude, Codex) and as a pi extension.

Response side:
- `PromptResponse._meta.neoworks.costUsd` — this turn's cost, when the adapter knows it exactly (our pi adapter). The core otherwise derives it from cumulative `usage_update`s.
- `PromptResponse._meta.neoworks.structuredOutput` when `outputSchema` given.
- `initialize` → `agentCapabilities._meta.neoworks = { harness, version, features: { systemPrompt: "replace"|"append"|null, tools: bool, outputSchema: bool, steering: bool, fork: bool, cost: bool, … } }` so apps degrade gracefully.

Custom methods: `_neoworks/steer {sessionId, prompt}`, `_neoworks/fork {sessionId, atMessageId?}`, `_neoworks/harnesses` (list detected + configured harnesses).
