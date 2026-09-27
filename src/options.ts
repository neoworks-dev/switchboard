import { z } from "zod";

export const HARNESS_IDS = ["claude", "codex", "pi"] as const;
export const BUILTIN_TOOLS = ["read", "write", "edit", "shell", "web_search", "web_fetch"] as const;
/** `ultracode` is Claude Code's xhigh plus standing workflow orchestration; elsewhere it means xhigh. */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultracode"] as const;
export const PERMISSION_POLICIES = ["ask", "auto-edit", "read-only", "full-access"] as const;
export const ISOLATION_LEVELS = ["full", "inherit"] as const;
/**
 * Harness extras that cost prompt tokens and tool slots but rarely help an app
 * that brings its own tools. Each driver maps what its harness has.
 */
export const FEATURES = [
  "subagents",
  "workflows",
  "todos",
  "scheduling",
  "worktrees",
  "plan_mode",
  "skills",
  "memory",
  "tool_search",
  "images",
  "user_questions",
] as const;
export const EDIT_MODES = ["native", "hashline"] as const;

/**
 * The `neoworks` extension vocabulary, sent as `_meta.neoworks` on
 * `session/new` and `session/resume`. Drivers translate it into per-session
 * adapter `_meta` or spawn-time config.
 */
export const sessionOptionsSchema = z
  .object({
    systemPrompt: z.object({ replace: z.string().optional(), append: z.string().optional() }).strict().optional(),
    /** `"default"` keeps the harness's own tool set; a list is exhaustive. */
    tools: z.union([z.enum(["default", "none"]), z.array(z.enum(BUILTIN_TOOLS))]).optional(),
    model: z.string().min(1).optional(),
    effort: z.enum(EFFORTS).optional(),
    /** `"full"` keeps the user's own config, instructions, MCP servers, hooks and skills out. */
    isolation: z.enum(ISOLATION_LEVELS).optional(),
    permissions: z.enum(PERMISSION_POLICIES).optional(),
    /** Harness features to switch off; `"all"` is every one the harness can drop. */
    disable: z.union([z.literal("all"), z.array(z.enum(FEATURES))]).optional(),
    /**
     * `"hashline"` swaps the harness's file read/edit tools for ones that
     * address lines by content hash instead of repeating old text.
     */
    edits: z.enum(EDIT_MODES).optional(),
    limits: z
      .object({ maxTurns: z.number().int().positive().optional(), maxBudgetUsd: z.number().positive().optional() })
      .strict()
      .optional(),
  })
  .strict();

export type SessionOptions = z.infer<typeof sessionOptionsSchema>;
export type HarnessId = (typeof HARNESS_IDS)[number];
export type BuiltinTool = (typeof BUILTIN_TOOLS)[number];
export type Effort = (typeof EFFORTS)[number];
export type PermissionPolicy = (typeof PERMISSION_POLICIES)[number];
export type Feature = (typeof FEATURES)[number];
export type EditMode = (typeof EDIT_MODES)[number];

/** The features `options.disable` switches off. */
export function disabledFeatures(options: SessionOptions): ReadonlySet<Feature> {
  return new Set(options.disable === "all" ? FEATURES : (options.disable ?? []));
}

/** Read `SessionOptions` from an ACP `_meta` object; absent means defaults. */
export function sessionOptionsFromMeta(meta: Record<string, unknown> | null | undefined): SessionOptions {
  return sessionOptionsSchema.parse(meta?.neoworks ?? {});
}
