import { z } from "zod";

import { repositoryIdSchema, utcDateTimeSchema } from "./validation.js";
import { fullShaSchema } from "./diff.js";

/**
 * Agent chat contracts (plan 13.1, 17.5). The session and message rows are
 * normalized LoongBoard data; DSH persistence is never parsed here.
 */

/**
 * A conversation origin is where a user opened the conversation.  It is kept
 * separate from the workspace binding used to run a turn.  The alias
 * `scope` remains in the wire contract for existing callers and persisted
 * sessions.
 */
export const agentScopeKindSchema = z.enum([
  "pr",
  "issue",
  "knowledge",
  "general",
  "repository",
  "domain",
]);

export const agentOriginKindSchema = agentScopeKindSchema;

export const agentOriginSchema = z
  .object({
    kind: agentScopeKindSchema,
    repositoryId: repositoryIdSchema.optional(),
    prNumber: z.number().int().positive().optional(),
    issueNumber: z.number().int().positive().optional(),
    targetSha: fullShaSchema.optional(),
    knowledgeDocumentId: z.string().trim().min(1).optional(),
    domainId: z.string().trim().min(1).optional(),
    /** Optional route metadata for callers that have a stable source URL. */
    route: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine(
    (scope) =>
      scope.kind !== "pr" ||
      (scope.repositoryId !== undefined &&
        scope.prNumber !== undefined &&
        scope.targetSha !== undefined),
    { message: "pr scope requires repositoryId, prNumber, and targetSha" },
  )
  .refine(
    (scope) =>
      scope.kind !== "issue" ||
      (scope.repositoryId !== undefined && scope.issueNumber !== undefined),
    { message: "issue scope requires repositoryId and issueNumber" },
  )
  .refine(
    (scope) => scope.kind !== "repository" || scope.repositoryId !== undefined,
    { message: "repository scope requires repositoryId" },
  )
  .refine(
    (scope) =>
      scope.kind !== "domain" ||
      (scope.repositoryId !== undefined && scope.domainId !== undefined),
    { message: "domain scope requires repositoryId and domainId" },
  );

/** Backwards-compatible name for the origin object used by current callers. */
export const agentScopeSchema = agentOriginSchema;

export const agentWorkspaceBindingSchema = z
  .object({
    path: z.string().min(1),
    kind: z
      .enum(["repository", "pr-worktree", "knowledge", "custom"])
      .optional(),
  })
  .strict();

/**
 * Runtime capability data is discovered from the connected runtime.  Model
 * entries keep their provider and supported reasoning values together so a
 * caller cannot accidentally offer a reasoning value for the wrong model.
 * Empty arrays are valid when the runtime is disconnected or its public
 * capability surface is unavailable.
 */
export const agentRuntimeModelCapabilitySchema = z
  .object({
    id: z.string().trim().min(1),
    label: z.string().trim().min(1).optional(),
    provider: z.string().trim().min(1),
    reasoningEfforts: z.array(z.string().trim().min(1)),
  })
  .strict();

export const agentRuntimeCommandCapabilitySchema = z
  .object({
    id: z.string().trim().min(1),
    label: z.string().trim().min(1).optional(),
    description: z.string().trim().min(1).optional(),
  })
  .strict();

/** Provider routes reported by the runtime's configurable-provider directory. */
export const agentRuntimeProviderCapabilitySchema = z
  .object({
    id: z.string().trim().min(1),
    label: z.string().trim().min(1).optional(),
  })
  .strict();

export const agentRuntimeCapabilitiesSchema = z
  .object({
    runtimeKind: z.string().trim().min(1),
    version: z.string().trim().min(1).nullable(),
    profile: z.string().trim().min(1).nullable(),
    connected: z.boolean(),
    models: z.array(agentRuntimeModelCapabilitySchema),
    /** Aggregate convenience values; model.reasoningEfforts is authoritative. */
    reasoning: z.array(z.string().trim().min(1)),
    commands: z.array(agentRuntimeCommandCapabilitySchema),
    /** Optional provider directory; absent keeps compatibility with older runtimes. */
    providers: z.array(agentRuntimeProviderCapabilitySchema).optional(),
    features: z.array(z.string().trim().min(1)),
    discovery: z.enum(["runtime", "unavailable"]),
    discoveredAt: utcDateTimeSchema.nullable().optional(),
    error: z.string().optional(),
  })
  .strict();

/** Ownership of a session title. Older responses may omit this field. */
export const agentSessionTitleSourceSchema = z.enum([
  "provisional",
  "generated",
  "manual",
]);

const agentTitleSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !/\r|\n|\u2028|\u2029/u.test(value), {
    message: "title must be one line",
  })
  .refine((value) => Array.from(value).length <= 80, {
    message: "title must contain at most 80 Unicode code points",
  });

export const agentSessionSummarySchema = z
  .object({
    id: z.string().min(1),
    scope: agentScopeSchema,
    workspacePath: z.string().min(1),
    dshHomePath: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    reasoningEffort: z.string().min(1),
    status: z.enum(["idle", "running", "interrupted", "error"]),
    dshSessionId: z.string().nullable(),
    /** Conversation origin; optional so older API/database rows remain readable. */
    origin: agentOriginSchema.optional(),
    /** Explicit workspace binding; `workspacePath` remains the compatibility field. */
    workspace: agentWorkspaceBindingSchema.optional(),
    title: z.string().trim().min(1).nullable().optional(),
    /** Optional on the wire so older clients can still read session summaries. */
    titleSource: agentSessionTitleSourceSchema.optional(),
    createdAt: utcDateTimeSchema,
    lastUsedAt: utcDateTimeSchema,
  })
  .strict();

export const agentSessionResponseSchema = z
  .object({
    session: agentSessionSummarySchema,
    targetRevision: z.string().min(1).nullable(),
    workspaceRevision: z.string().min(1).nullable(),
  })
  .strict();

/** The chat message row as stored and returned to the UI. */
export const agentMessageSchema = z
  .object({
    id: z.string().min(1),
    sessionId: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    role: z.enum(["user", "assistant", "tool", "system-status"]),
    contentMarkdown: z.string(),
    metadataJson: z.record(z.string(), z.unknown()),
    createdAt: utcDateTimeSchema,
  })
  .strict();

export const agentMessagesResponseSchema = z
  .object({
    items: z.array(agentMessageSchema),
  })
  .strict();

const agentSessionCreateBodySchema = z
  .object({
    /** `scope` is retained for clients using the original API shape. */
    scope: agentScopeSchema,
    origin: agentOriginSchema.optional(),
    workspace: agentWorkspaceBindingSchema.optional(),
    title: agentTitleSchema.optional(),
    provider: z.string().trim().min(1).optional(),
    model: z.string().trim().min(1).optional(),
    reasoningEffort: z.string().trim().min(1).optional(),
  })
  .strict();

/** Accept the new `origin` name while keeping typed/HTTP compatibility with `scope`. */
export const agentSessionCreateSchema = z.preprocess((input) => {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return input;
  }
  const value = input as Record<string, unknown>;
  if (value.scope === undefined && value.origin !== undefined) {
    return { ...value, scope: value.origin };
  }
  return value;
}, agentSessionCreateBodySchema);

export const agentMessageCreateSchema = z
  .object({
    content: z.string().trim().min(1).max(200_000),
  })
  .strict();

/** Update the route for future turns; active turns must be stopped first. */
export const agentSessionUpdateSchema = z
  .object({
    provider: z.string().trim().min(1).optional(),
    model: z.string().trim().min(1).optional(),
    reasoningEffort: z.string().trim().min(1).optional(),
    title: agentTitleSchema.nullable().optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: "At least one session setting must be provided",
  });

export const agentMessageAcceptedSchema = z
  .object({
    messageId: z.string().min(1),
    status: z.literal("accepted"),
  })
  .strict();

export const agentParamsSchema = z.object({
  id: z.string().trim().min(1).max(128),
});

/**
 * Session list filter (plan 12.4 old-chat discovery). Every field is optional;
 * Fastify query values arrive as strings and are coerced here once.
 */
export const agentSessionsQuerySchema = z
  .object({
    scopeType: agentScopeKindSchema.optional(),
    originKind: agentOriginKindSchema.optional(),
    repositoryId: z.string().trim().min(1).optional(),
    prNumber: z.preprocess(
      (value) => (value === undefined ? undefined : Number(value)),
      z.number().int().positive().optional(),
    ),
    issueNumber: z.preprocess(
      (value) => (value === undefined ? undefined : Number(value)),
      z.number().int().positive().optional(),
    ),
    knowledgeDocumentId: z.string().trim().min(1).optional(),
    status: z.enum(["idle", "running", "interrupted", "error"]).optional(),
    search: z.string().trim().max(200).optional(),
    q: z.string().trim().max(200).optional(),
    limit: z.preprocess(
      (value) => (value === undefined ? undefined : Number(value)),
      z.number().int().positive().max(200).optional(),
    ),
  })
  .strict();

export const agentSessionsResponseSchema = z
  .object({
    items: z.array(agentSessionSummarySchema),
  })
  .strict();

/** A value offered by the runtime for an approval interaction. */
export const agentInteractionOptionSchema = z
  .object({
    id: z.string().trim().min(1),
    label: z.string().trim().min(1),
  })
  .strict();

/** Runtime approval request; the runtime remains the authority for options. */
export const agentInteractionRequestedSchema = z
  .object({
    type: z.literal("interaction.requested"),
    requestId: z.string().trim().min(1),
    kind: z.literal("approval"),
    title: z.string().trim().min(1),
    description: z.string().trim().min(1).optional(),
    options: z.array(agentInteractionOptionSchema),
  })
  .strict();

/** Runtime acknowledgement that an interaction value was accepted. */
export const agentInteractionResolvedSchema = z
  .object({
    type: z.literal("interaction.resolved"),
    requestId: z.string().trim().min(1),
  })
  .strict();

export const agentInteractionParamsSchema = z
  .object({
    id: z.string().trim().min(1).max(128),
    requestId: z.string().trim().min(1).max(256),
  })
  .strict();

export const agentInteractionResponseSchema = z
  .object({ value: z.string().trim().min(1).max(200) })
  .strict();

/** One streamed runtime event (plan 13.1), JSON-serializable for SSE. */
export const agentRuntimeEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("status"), status: z.enum(["starting", "running", "idle", "stopped"]) }).strict(),
  z.object({ type: z.literal("assistant.delta"), text: z.string() }).strict(),
  z.object({ type: z.literal("assistant.completed"), markdown: z.string() }).strict(),
  z.object({ type: z.literal("tool.started"), callId: z.string(), name: z.string(), summary: z.string().optional() }).strict(),
  z.object({ type: z.literal("tool.completed"), callId: z.string(), name: z.string(), summary: z.string().optional(), isError: z.boolean() }).strict(),
  agentInteractionRequestedSchema,
  agentInteractionResolvedSchema,
  z
    .object({
      type: z.literal("agent.activity"),
      kind: z.enum([
        "reasoning",
        "command",
        "job",
        "subagent",
        "plan",
        "approval",
        "workspace",
        "runtime",
      ]),
      phase: z.enum(["started", "updated", "completed", "failed"]),
      id: z.string().optional(),
      title: z.string().optional(),
      summary: z.string().optional(),
      data: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
  z.object({ type: z.literal("error"), message: z.string() }).strict(),
]);

export const agentSessionDeleteResponseSchema = z
  .object({ deleted: z.literal(true) })
  .strict();

export type AgentScope = z.infer<typeof agentScopeSchema>;
export type AgentOrigin = z.infer<typeof agentOriginSchema>;
export type AgentOriginKind = z.infer<typeof agentOriginKindSchema>;
export type AgentWorkspaceBinding = z.infer<typeof agentWorkspaceBindingSchema>;
export type AgentRuntimeModelCapability = z.infer<
  typeof agentRuntimeModelCapabilitySchema
>;
export type AgentRuntimeCommandCapability = z.infer<
  typeof agentRuntimeCommandCapabilitySchema
>;
export type AgentRuntimeProviderCapability = z.infer<
  typeof agentRuntimeProviderCapabilitySchema
>;
export type AgentRuntimeCapabilities = z.infer<
  typeof agentRuntimeCapabilitiesSchema
>;
export type AgentSessionTitleSource = z.infer<
  typeof agentSessionTitleSourceSchema
>;
export type AgentScopeKind = z.infer<typeof agentScopeKindSchema>;
export type AgentSessionSummary = z.infer<typeof agentSessionSummarySchema>;
export type AgentSessionResponse = z.infer<typeof agentSessionResponseSchema>;
export type AgentMessage = z.infer<typeof agentMessageSchema>;
export type AgentMessagesResponse = z.infer<typeof agentMessagesResponseSchema>;
export type AgentSessionCreate = z.infer<typeof agentSessionCreateSchema>;
export type AgentMessageCreate = z.infer<typeof agentMessageCreateSchema>;
export type AgentSessionUpdate = z.infer<typeof agentSessionUpdateSchema>;
export type AgentMessageAccepted = z.infer<typeof agentMessageAcceptedSchema>;
export type AgentParams = z.infer<typeof agentParamsSchema>;
export type AgentRuntimeEvent = z.infer<typeof agentRuntimeEventSchema>;
export type AgentSessionsQuery = z.infer<typeof agentSessionsQuerySchema>;
export type AgentSessionsResponse = z.infer<typeof agentSessionsResponseSchema>;
export type AgentSessionDeleteResponse = z.infer<typeof agentSessionDeleteResponseSchema>;
export type AgentInteractionOption = z.infer<typeof agentInteractionOptionSchema>;
export type AgentInteractionRequested = z.infer<typeof agentInteractionRequestedSchema>;
export type AgentInteractionResolved = z.infer<typeof agentInteractionResolvedSchema>;
export type AgentInteractionParams = z.infer<typeof agentInteractionParamsSchema>;
export type AgentInteractionResponse = z.infer<typeof agentInteractionResponseSchema>;
