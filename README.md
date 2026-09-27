# @neoworks/harness

One SDK for putting Claude Code, Codex and pi to work from your own app, on your own subscriptions.

Your app says what the session is for: its system prompt, which tools it may use, which MCP servers it gets, how isolated it is from your personal harness config. The SDK turns that into whatever each harness understands and streams the result back as [ACP](https://agentclientprotocol.com) events. Write the integration once, let the user pick the harness.

```ts
import { createHarness } from "@neoworks/harness";

const harness = await createHarness();
const session = await harness.createSession({
  harness: "claude", // or "codex", "pi"
  cwd: process.cwd(),
  mcpServers: [{ type: "http", name: "app", url: "http://127.0.0.1:7801/mcp", headers: [] }],
  options: {
    systemPrompt: { replace: "You edit photos through the app's tools." },
    tools: "none", // no shell, no file tools: only the app's MCP server
    isolation: "full", // ignore ~/.claude, ~/.codex, ~/.pi
    disable: "all", // no subagents, workflows, todos, skills, …
    model: "haiku",
    effort: "low",
  },
  onPermission: (request) => (request.toolCall.title?.startsWith("export") ? "reject" : "once"),
});

for await (const event of session.prompt("Make the sky moodier")) {
  if (event.type === "update") console.log(event.update.sessionUpdate);
}
const { stopReason, usage } = await session.prompt("Now undo that");
```

## In-process or through a sidecar

`Harness` spawns the harnesses as child processes, so it needs Node (an Electron main process, a CLI, a server). A sandboxed page can't spawn anything; it talks to a sidecar instead, through the same API:

```sh
NEOWORKS_HARNESS_TOKEN=… neoworks-harness serve   # prints: listening on ws://127.0.0.1:43117
```

```ts
import { HarnessClient } from "@neoworks/harness/client"; // browser-safe

const harness = await HarnessClient.connect({ url: "ws://127.0.0.1:43117", token });
const session = await harness.createSession({ … }); // same SessionInit as above
```

`Harness` and `HarnessClient` both implement `HarnessApi`:

| | |
|---|---|
| `listHarnesses()` | detected harnesses, their capabilities and effort levels |
| `listModels(harness)` | models the harness offers under your login |
| `createSession(init)` / `resumeSession(id, init)` | a `HarnessSession` |
| `session.prompt(content)` | a `PromptRun`: iterate it for events, await it for `{ stopReason, usage }`; leaving the loop early cancels |
| `session.onEvent(listener)` | every event of every turn |
| `session.cancel()` / `session.close()` | |

The wire is plain ACP over WebSocket plus three `_neoworks/*` methods (`src/shared/wire.ts`), so any ACP client can drive the sidecar.

## Session options

| Option | Values | Claude Code | Codex | pi |
|---|---|---|---|---|
| `systemPrompt` | `{ replace?, append? }` | ✓ | ✓ | ✓ |
| `tools` | `"default"`, `"none"`, or `read`/`write`/`edit`/`shell`/`web_search`/`web_fetch` | ✓ | ✓ (a hook refuses `apply_patch`, which no setting removes) | ✓ (no web tools) |
| `model`, `effort` | `low` … `max`, `ultracode` | ✓ | up to `xhigh` | up to `max` |
| `isolation` | `"full"`, `"inherit"` | mostly | ✓ | ✓ |
| `permissions` | `ask`, `auto-edit`, `read-only`, `full-access` | ✓ | ✓ | ✓ (via our pi extension) |
| `disable` | `"all"` or `subagents`, `workflows`, `todos`, `scheduling`, `worktrees`, `plan_mode`, `skills`, `memory`, `tool_search`, `images`, `user_questions` | ✓ | ✓ | nothing to disable |
| `edits` | `"native"`, `"hashline"` | ✓ | ✓ | ✓ |
| `limits` | `{ maxTurns?, maxBudgetUsd? }` | ✓ | – | – |

`edits: "hashline"` swaps the harness's file read/edit tools for ones that address lines by a short content hash (`12#ZP:text`), after [oh-my-pi](https://github.com/can1357/oh-my-pi).

## Hooks

```ts
await harness.createSession({
  …,
  hooks: {
    beforeToolUse: ({ toolName, input }) => (toolName === "Bash" ? { block: "No shell in this app." } : undefined),
    afterToolUse: ({ toolName }) => ({ context: "Check the preview before the next edit." }),
    onPromptSubmit: ({ prompt }) => undefined,
    onStop: ({ continued }) => (continued ? undefined : { continue: "Verify the result first." }),
  },
});
```

The harness runs these natively (Claude and Codex command hooks, a pi extension) and asks your function over a local socket, so they can block. They never grant a permission.

## CLI

```sh
neoworks-harness detect
neoworks-harness run --harness pi --model openai-codex/gpt-6-luna --tools none --isolation full "hello"
neoworks-harness serve
```

## Requirements

Node 22.6+ (types are stripped at runtime; Electron works through `ELECTRON_RUN_AS_NODE`). The harnesses you want, logged in: `claude`, `codex login`, `pi`. pi needs `pi-mcp-adapter` for MCP servers.

Design notes and per-harness research: `docs/`.

## License

MIT
