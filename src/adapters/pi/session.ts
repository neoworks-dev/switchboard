import * as acp from "@agentclientprotocol/sdk";
import type { HookBridge } from "../../drivers/types.ts";
import type { SessionOptions } from "../../types.ts";
import { buildLaunch, findMcpAdapter, prepareIsolatedAgentDir, writeMcpConfig, type LaunchContext } from "./launch.ts";
import { PERMISSION_TITLE, type PermissionQuestion } from "./bridge.ts";
import type { AssistantMessage, Event, Model, SessionStats, UiRequest } from "./protocol.ts";
import { PiRpc } from "./rpc.ts";
import { stopReasonOf, toolKind, toolTitle, toPiPrompt, toSessionUpdates, usageDelta, usageUpdate } from "./translate.ts";

export type StartParams = {
  cwd: string;
  mcpServers: acp.McpServer[];
  options: SessionOptions;
  /** pi session id to resume. */
  resume?: string;
  hooks?: HookBridge;
};

export type ModelState = { currentModelId: string; availableModels: Array<{ modelId: string; name: string }> };

type Turn = {
  cancelled: boolean;
  lastAssistant?: AssistantMessage;
  settle(): void;
};

/** One ACP session backed by its own `pi --mode rpc` process. */
export class PiSession {
  readonly id: string;
  private readonly rpc: PiRpc;
  private readonly client: acp.AgentContext;
  private readonly alwaysAllowed = new Set<string>();
  /** ACP's (still unstable) session model state; ids are pi's `provider/model`. */
  readonly models: ModelState;
  private turn?: Turn;
  private stats?: SessionStats;

  private constructor(id: string, rpc: PiRpc, client: acp.AgentContext, stats: SessionStats, models: ModelState) {
    this.id = id;
    this.rpc = rpc;
    this.client = client;
    this.stats = stats;
    this.models = models;
    rpc.onEvent = (event) => this.handleEvent(event);
    rpc.onUiRequest = (request) => void this.handleUiRequest(request);
  }

  static async start(params: StartParams, client: acp.AgentContext): Promise<PiSession> {
    const launch = buildLaunch(params.options, prepareContext(params));
    const rpc = new PiRpc(launch.args, { cwd: params.cwd, env: launch.env, command: process.env.NEOWORKS_PI_COMMAND });
    const exited = rpc.exited.then(() => {
      throw acp.RequestError.internalError(undefined, rpc.describeExit());
    });
    const [state, stats, { models }] = await Promise.race([
      Promise.all([rpc.request("get_state", {}), rpc.request("get_session_stats", {}), rpc.request("get_available_models", {})]),
      exited,
    ]);
    if (params.resume && state.sessionId !== params.resume) {
      await rpc.close();
      throw acp.RequestError.resourceNotFound(params.resume);
    }
    const modelId = (model: Model) => `${model.provider}/${model.id}`;
    const modelState: ModelState = {
      currentModelId: state.model ? modelId(state.model) : "",
      availableModels: models.map((model) => ({ modelId: modelId(model), name: model.name })),
    };
    return new PiSession(state.sessionId, rpc, client, stats, modelState);
  }

  async prompt(blocks: acp.ContentBlock[]): Promise<acp.PromptResponse> {
    if (this.turn) throw acp.RequestError.invalidRequest(undefined, "a prompt is already running in this session");
    const { message, images } = toPiPrompt(blocks);

    let settle!: () => void;
    const settled = new Promise<void>((resolve) => (settle = resolve));
    const turn: Turn = { cancelled: false, settle };
    this.turn = turn;
    try {
      const accepted = await this.rpc.request("prompt", { message, images: images.length ? images : undefined });
      // "handled" means no run started (e.g. an extension command consumed it), so nothing will settle.
      if (accepted?.disposition !== "handled") {
        await Promise.race([settled, this.rpc.exited.then(() => Promise.reject(new Error(this.rpc.describeExit())))]);
      }
      const { usage, costUsd } = await this.refreshUsage();
      return { stopReason: stopReasonOf(turn.lastAssistant, turn.cancelled), usage, _meta: { neoworks: { costUsd } } };
    } finally {
      this.turn = undefined;
    }
  }

  async cancel(): Promise<void> {
    if (!this.turn) return;
    this.turn.cancelled = true;
    await this.rpc.request("abort", {});
  }

  close(): Promise<void> {
    return this.rpc.close();
  }

  private handleEvent(event: Event): void {
    for (const update of toSessionUpdates(event)) {
      void this.client.notify("session/update", { sessionId: this.id, update });
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      if (this.turn) this.turn.lastAssistant = event.message as AssistantMessage;
    } else if (event.type === "agent_settled") {
      this.turn?.settle();
    }
  }

  /** This turn's tokens and cost; pi only reports session totals. */
  private async refreshUsage(): Promise<{ usage: acp.Usage; costUsd: number }> {
    const stats = await this.rpc.request("get_session_stats", {});
    const usage = usageDelta(this.stats, stats);
    const costUsd = stats.cost - (this.stats?.cost ?? 0);
    this.stats = stats;
    await this.client.notify("session/update", { sessionId: this.id, update: usageUpdate(stats) });
    return { usage, costUsd };
  }

  private async handleUiRequest(request: UiRequest): Promise<void> {
    switch (request.method) {
      case "confirm": {
        const confirmed = await this.confirm(request).catch(() => false);
        this.rpc.respond({ type: "extension_ui_response", id: request.id, confirmed });
        return;
      }
      case "select":
      case "input":
      case "editor":
        // ACP has no generic dialog; decline rather than hang the extension.
        this.rpc.respond({ type: "extension_ui_response", id: request.id, cancelled: true });
        return;
      default:
        // notify / setStatus / setWidget / setTitle / set_editor_text expect no reply.
        return;
    }
  }

  private async confirm(request: Extract<UiRequest, { method: "confirm" }>): Promise<boolean> {
    if (request.title !== PERMISSION_TITLE) {
      return this.askPermission({ toolCallId: `pi-dialog-${request.id}`, title: request.title, kind: "other" });
    }
    const question = JSON.parse(request.message) as PermissionQuestion;
    if (this.alwaysAllowed.has(question.toolName)) return true;
    const input = (question.input ?? {}) as Record<string, unknown>;
    return this.askPermission(
      { toolCallId: question.toolCallId, title: toolTitle(question.toolName, input), kind: toolKind(question.toolName), rawInput: input },
      question.toolName,
    );
  }

  /** Ask the ACP client; with `rememberAs`, an "always" answer skips future prompts for that tool. */
  private async askPermission(toolCall: acp.ToolCallUpdate, rememberAs?: string): Promise<boolean> {
    const options: acp.PermissionOption[] = [
      { optionId: "allow_once", name: "Allow", kind: "allow_once" },
      ...(rememberAs ? [{ optionId: "allow_always", name: `Always allow ${rememberAs}`, kind: "allow_always" as const }] : []),
      { optionId: "reject_once", name: "Reject", kind: "reject_once" },
    ];
    const { outcome } = await this.client.request("session/request_permission", { sessionId: this.id, toolCall, options });
    if (outcome.outcome !== "selected") return false;
    if (outcome.optionId === "allow_always" && rememberAs) this.alwaysAllowed.add(rememberAs);
    return outcome.optionId !== "reject_once";
  }
}

function prepareContext(params: StartParams): LaunchContext {
  const isolated = params.options.isolation === "full";
  const context: LaunchContext = { resume: params.resume, hooks: params.hooks };
  if (isolated) context.isolatedAgentDir = prepareIsolatedAgentDir();
  if (params.mcpServers.length > 0) {
    const adapter = findMcpAdapter();
    if (!adapter) {
      throw acp.RequestError.invalidParams(undefined, "MCP servers need the pi-mcp-adapter package: pi install npm:pi-mcp-adapter");
    }
    context.mcpConfigPath = writeMcpConfig(params.mcpServers);
    // An isolated agent dir doesn't load the user's packages, so the adapter must come in explicitly.
    if (isolated || !adapter.activePackage) context.mcpAdapterPath = adapter.path;
  }
  return context;
}
