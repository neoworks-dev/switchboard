import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { claude } from "../drivers/claude.ts";
import { codex } from "../drivers/codex.ts";
import { pi } from "../drivers/pi.ts";
import type { Detection, Driver, DriverContext } from "../drivers/types.ts";
import { HookServer } from "../hooks/server.ts";
import type { HookName } from "../hooks/types.ts";
import type { HarnessApi, HarnessId, HarnessInfo, ModelInfo, SessionInit, SessionOptions } from "../types.ts";
import type { AgentProcess } from "./agent-process.ts";
import { ProcessPool } from "./pool.ts";
import { rejectPermission, Session } from "./session.ts";

export type HarnessConfig = {
  /** Harness used when a session doesn't name one. */
  harness?: HarnessId;
};

export const CONFIG_PATH = join(homedir(), ".config", "neoworks", "harness.json");

export async function loadConfig(path = CONFIG_PATH): Promise<HarnessConfig> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as HarnessConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

/** Runs harnesses in this process's children. Needs Node; browsers use `HarnessClient`. */
export class Harness implements HarnessApi {
  readonly drivers: ReadonlyMap<HarnessId, Driver>;
  private readonly pool = new ProcessPool();
  private hookServer?: Promise<HookServer>;
  private readonly models = new Map<HarnessId, Promise<ModelInfo[]>>();
  readonly config: HarnessConfig;

  constructor(config: HarnessConfig = {}, drivers: Driver[] = [claude, codex, pi]) {
    this.config = config;
    this.drivers = new Map(drivers.map((driver) => [driver.id, driver]));
  }

  async detect(): Promise<Partial<Record<HarnessId, Detection>>> {
    const entries = await Promise.all(
      [...this.drivers.values()].map(async (driver) => [driver.id, await driver.detect()] as const),
    );
    return Object.fromEntries(entries);
  }

  async listHarnesses(): Promise<HarnessInfo[]> {
    return Promise.all(
      [...this.drivers.values()].map(async (driver) => ({
        id: driver.id,
        ...(await driver.detect()),
        capabilities: driver.capabilities,
        efforts: driver.efforts,
      })),
    );
  }

  /**
   * Asks the harness through a throwaway session, since models depend on the
   * user's login. Cached per harness for the life of this `Harness`.
   */
  listModels(harness: HarnessId): Promise<ModelInfo[]> {
    let models = this.models.get(harness);
    if (!models) {
      models = this.probeModels(harness);
      models.catch(() => this.models.delete(harness));
      this.models.set(harness, models);
    }
    return models;
  }

  async createSession(init: SessionInit): Promise<Session> {
    return (await this.open(init, false, (agent, request) => agent.request("session/new", request))).session;
  }

  async resumeSession(sessionId: string, init: SessionInit): Promise<Session> {
    const { session } = await this.open(init, true, async (agent, request) => {
      const capabilities = agent.initialize.agentCapabilities;
      if (capabilities?.sessionCapabilities?.resume) {
        return { ...(await agent.request("session/resume", { ...request, sessionId })), sessionId };
      }
      if (capabilities?.loadSession) {
        return { ...(await agent.request("session/load", { ...request, sessionId })), sessionId };
      }
      throw new Error(`${agent.initialize.agentInfo?.name ?? "this harness"} cannot resume sessions`);
    });
    return session;
  }

  /** Kill agent processes that no longer serve any session. */
  reap(): void {
    this.pool.reap();
  }

  async close(): Promise<void> {
    await this.pool.close();
    await (await this.hookServer)?.close();
  }

  private async probeModels(harness: HarnessId): Promise<ModelInfo[]> {
    const probe: SessionOptions = { isolation: "full", tools: "none" };
    const { session, started, agent } = await this.open({ harness, cwd: tmpdir(), options: probe }, false, (agent, request) =>
      agent.request("session/new", request),
    );
    await session.close();
    if (agent.initialize.agentCapabilities?.sessionCapabilities?.close) {
      await agent.request("session/close", { sessionId: session.id }).catch(() => {});
    }
    return modelsOf(started);
  }

  private async open(init: SessionInit, resumed: boolean, start: StartSession): Promise<Opened> {
    const id = init.harness ?? this.config.harness ?? DEFAULT_HARNESS;
    const driver = this.drivers.get(id);
    if (!driver) throw new Error(`unknown harness "${id}"`);
    const options = init.options ?? {};
    const hookNames = Object.keys(init.hooks ?? {}) as HookName[];
    const hookServer = hookNames.length ? await this.startHookServer() : undefined;
    const cwd = init.cwd ?? process.cwd();
    const context: DriverContext = {
      cwd,
      hooks: hookServer && { address: hookServer.address, hooks: hookNames },
    };
    const mcpServers = [...(init.mcpServers ?? []), ...(driver.mcpServers?.(options, context) ?? [])];

    const agent = await this.pool.acquire(await driver.spawn(options, context));
    assertMcpSupported(id, mcpServers, agent.initialize.agentCapabilities?.mcpCapabilities);

    // Adapters don't remember `_meta`; it has to accompany every new/load/resume.
    const started = await start(agent, {
      cwd,
      mcpServers,
      _meta: { ...driver.sessionMeta(options, context), neoworks: options },
    });
    const session = new Session(agent, started.sessionId, id, {
      onPermission: init.onPermission ?? rejectPermission,
      resumed,
      unregisterHooks: hookServer && init.hooks && hookServer.register(started.sessionId, init.hooks),
    });
    try {
      await driver.configure?.(agent, started.sessionId, started.modes ?? undefined, options);
    } catch (error) {
      await session.close();
      throw error;
    }
    return { session, started, agent };
  }

  private startHookServer(): Promise<HookServer> {
    this.hookServer ??= HookServer.start();
    return this.hookServer;
  }
}

type SessionRequest = Pick<acp.NewSessionRequest, "cwd" | "mcpServers" | "_meta">;

/**
 * What session/new, resume and load answer, reduced to what `open` reads.
 * `models` is still unstable ACP, so the SDK's response types lack it.
 */
type Started = Pick<acp.NewSessionResponse, "sessionId" | "modes" | "configOptions"> & {
  models?: { availableModels: Array<{ modelId: string; name: string; description?: string | null }> } | null;
};

type StartSession = (agent: AgentProcess, request: SessionRequest) => Promise<Started>;

type Opened = { session: Session; started: Started; agent: AgentProcess };

const DEFAULT_HARNESS: HarnessId = "claude";

export async function createHarness(config?: HarnessConfig): Promise<Harness> {
  return new Harness(config ?? (await loadConfig()));
}

/** Claude reports `models`; Codex a config option in the "model" category. */
function modelsOf(started: Started): ModelInfo[] {
  if (started.models) {
    return started.models.availableModels.map((model) => ({
      id: model.modelId,
      name: model.name,
      description: model.description ?? undefined,
    }));
  }
  const option = started.configOptions?.find((candidate) => candidate.category === "model");
  if (option?.type !== "select") return [];
  return option.options.flatMap((entry) => ("options" in entry ? entry.options : [entry])).map((value) => ({
    id: value.value,
    name: value.name,
    description: value.description ?? undefined,
  }));
}

function assertMcpSupported(
  harness: HarnessId,
  servers: acp.McpServer[],
  caps: acp.McpCapabilities | undefined,
): void {
  for (const server of servers) {
    const transport = "type" in server ? server.type : "stdio";
    if (transport === "http" && !caps?.http) throw new Error(`${harness} does not support http MCP servers`);
    if (transport === "sse" && !caps?.sse) throw new Error(`${harness} does not support sse MCP servers`);
  }
}
