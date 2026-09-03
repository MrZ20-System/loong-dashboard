import { z } from "zod";

import { repositoryIdSchema, utcDateTimeSchema } from "./validation.js";
import { fullShaSchema } from "./diff.js";

/**
 * Agent chat contracts (plan 13.1, 17.5). The session and message rows are
 * normalized LoongBoard data; DSH persistence is never parsed here.
 */

export const agentScopeKindSchema = z.enum(["pr", "issue", "knowledge", "general"]);

export const agentScopeSchema = z
  .object({
    kind: agentScopeKindSchema,
    repositoryId: repositoryIdSchema.optional(),
    prNumber: z.number().int().positive().optional(),
    issueNumber: z.number().int().positive().optional(),
    targetSha: fullShaSchema.optional(),
    knowledgeDocumentId: z.string().trim().min(1).optional(),
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
  );

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

export const agentSessionCreateSchema = z
  .object({
    scope: agentScopeSchema,
    provider: z.string().trim().min(1).optional(),
    model: z.string().trim().min(1).optional(),
    reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
  })
  .strict();

export const agentMessageCreateSchema = z
  .object({
    content: z.string().trim().min(1).max(200_000),
  })
  .strict();

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
    scopeType: z.enum(["pr", "issue", "knowledge", "general"]).optional(),
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
  })
  .strict();

export const agentSessionsResponseSchema = z
  .object({
    items: z.array(agentSessionSummarySchema),
  })
  .strict();

/** One streamed runtime event (plan 13.1), JSON-serializable for SSE. */
export const agentRuntimeEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("status"), status: z.enum(["starting", "running", "idle", "stopped"]) }).strict(),
  z.object({ type: z.literal("assistant.delta"), text: z.string() }).strict(),
  z.object({ type: z.literal("assistant.completed"), markdown: z.string() }).strict(),
  z.object({ type: z.literal("tool.started"), callId: z.string(), name: z.string(), summary: z.string().optional() }).strict(),
  z.object({ type: z.literal("tool.completed"), callId: z.string(), name: z.string(), summary: z.string().optional(), isError: z.boolean() }).strict(),
  z.object({ type: z.literal("error"), message: z.string() }).strict(),
]);

export type AgentScope = z.infer<typeof agentScopeSchema>;
export type AgentScopeKind = z.infer<typeof agentScopeKindSchema>;
export type AgentSessionSummary = z.infer<typeof agentSessionSummarySchema>;
export type AgentSessionResponse = z.infer<typeof agentSessionResponseSchema>;
export type AgentMessage = z.infer<typeof agentMessageSchema>;
export type AgentMessagesResponse = z.infer<typeof agentMessagesResponseSchema>;
export type AgentSessionCreate = z.infer<typeof agentSessionCreateSchema>;
export type AgentMessageCreate = z.infer<typeof agentMessageCreateSchema>;
export type AgentMessageAccepted = z.infer<typeof agentMessageAcceptedSchema>;
export type AgentParams = z.infer<typeof agentParamsSchema>;
export type AgentRuntimeEvent = z.infer<typeof agentRuntimeEventSchema>;
export type AgentSessionsQuery = z.infer<typeof agentSessionsQuerySchema>;
export type AgentSessionsResponse = z.infer<typeof agentSessionsResponseSchema>;
