import { z } from "zod";

import { repositoryIdSchema, utcDateTimeSchema } from "./validation.js";
import { agentRuntimeCapabilitiesSchema } from "./agent.js";

/** Settings are persisted by the local server and never by the browser. */
export const repositorySettingsSchema = z
  .object({
    repositoryId: repositoryIdSchema,
    automaticSync: z.boolean(),
    syncFrequencyMinutes: z.number().int().positive(),
    /** Initial/bootstrap metadata window measured by GitHub updated_at. */
    syncLookbackDays: z.union([z.literal(7), z.literal(30)]),
    nextSyncAt: utcDateTimeSchema.nullable().optional(),
    lastSyncAt: utcDateTimeSchema.nullable().optional(),
    lastError: z.string().nullable().optional(),
  })
  .strict();

export const repositorySettingsUpdateSchema = z
  .object({
    automaticSync: z.boolean().optional(),
    syncFrequencyMinutes: z.number().int().positive().optional(),
    syncLookbackDays: z.union([z.literal(7), z.literal(30)]).optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: "At least one setting must be provided",
  });

export const githubQuotaSchema = z
  .object({
    remaining: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    resetAt: utcDateTimeSchema.nullable(),
  })
  .strict();

export const githubCredentialSourceSchema = z.enum([
  "settings",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "gh",
  "none",
]);

export const githubAccountSchema = z
  .object({
    login: z.string().trim().min(1),
    name: z.string().trim().min(1).nullable().optional(),
  })
  .strict();

export const githubIntegrationSchema = z
  .object({
    configured: z.boolean(),
    source: githubCredentialSourceSchema,
    account: githubAccountSchema.nullable(),
    rest: githubQuotaSchema.nullable(),
    graphql: githubQuotaSchema.nullable(),
    lastVerifiedAt: utcDateTimeSchema.nullable(),
  })
  .strict();

export const githubTokenUpdateSchema = z
  .object({ token: z.string().trim().min(1) })
  .strict();

/** Runtime data is a projection; DSH remains the model/catalog authority. */
export const agentRuntimeSettingsSchema = z
  .object({
    status: z.string().trim().min(1),
    version: z.string().trim().min(1).nullable(),
    profile: z.string().trim().min(1).nullable(),
    connected: z.boolean(),
    defaultProvider: z.string().trim().min(1).nullable(),
    defaultModel: z.string().trim().min(1).nullable(),
    defaultReasoning: z.string().trim().min(1).nullable(),
    /** Zero means Never and is shared with the config/runtime contract. */
    retentionMinutes: z.number().int().nonnegative(),
    /** Runtime-owned catalog; DSH remains the source of truth. */
    capabilities: agentRuntimeCapabilitiesSchema.nullable(),
  })
  .strict();

export const agentRuntimeSettingsUpdateSchema = z
  .object({
    defaultProvider: z.string().trim().min(1).nullable().optional(),
    defaultModel: z.string().trim().min(1).nullable().optional(),
    defaultReasoning: z.string().trim().min(1).nullable().optional(),
    retentionMinutes: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: "At least one setting must be provided",
  });

export const providerSecretUpdateSchema = z
  .object({
    provider: z.string().trim().min(1),
    secret: z.string().min(1),
  })
  .strict();

export const jsonSourceSchema = z
  .object({
    path: z.string().trim().min(1),
    content: z.string(),
    version: z.number().int().positive().nullable().optional(),
    versionId: z.string().trim().min(1).nullable().optional(),
    hash: z.string().trim().min(1).nullable().optional(),
    /** Present when an external/Agent edit is readable but not projectable. */
    parseError: z.string().nullable().optional(),
  })
  .strict();

export const jsonSourceUpdateSchema = z
  .object({ content: z.string() })
  .strict();

export const jsonSourceVersionSourceSchema = z.enum([
  "manual",
  "agent",
  "external",
  "restore",
]);

export const jsonSourceVersionSchema = z
  .object({
    id: z.string().trim().min(1),
    path: z.string().trim().min(1),
    version: z.number().int().positive(),
    hash: z.string().trim().min(1),
    source: jsonSourceVersionSourceSchema,
    createdAt: utcDateTimeSchema,
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict();

export const jsonSourceVersionsResponseSchema = z
  .object({ items: z.array(jsonSourceVersionSchema) })
  .strict();

export const jsonSourceVersionDetailSchema = jsonSourceVersionSchema
  .extend({ content: z.string() })
  .strict();

export const jsonSourceVersionParamsSchema = z
  .object({ id: repositoryIdSchema, versionId: z.string().trim().min(1) })
  .strict();

/** Knowledge is the only repository currently allowed to auto checkpoint. */
export const knowledgeCheckpointSettingsSchema = z
  .object({
    autoCommit: z.boolean(),
    autoPush: z.boolean(),
    remote: z.string().trim().min(1),
    branch: z.string().trim().min(1),
    intervalMinutes: z.number().int().positive().nullable().optional(),
    nextRunAt: utcDateTimeSchema.nullable().optional(),
    lastSuccessAt: utcDateTimeSchema.nullable().optional(),
    lastError: z.string().nullable().optional(),
  })
  .strict();

export const knowledgeCheckpointSettingsUpdateSchema = z
  .object({
    autoCommit: z.boolean().optional(),
    autoPush: z.boolean().optional(),
    remote: z.string().trim().min(1).optional(),
    branch: z.string().trim().min(1).optional(),
    intervalMinutes: z.number().int().positive().nullable().optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: "At least one setting must be provided",
  });

export const repositorySettingsParamsSchema = z
  .object({ id: repositoryIdSchema })
  .strict();

export const settingsResponseSchema = z
  .object({
    repositories: z.array(repositorySettingsSchema),
    github: githubIntegrationSchema,
    agent: agentRuntimeSettingsSchema,
    checkpoint: knowledgeCheckpointSettingsSchema,
  })
  .strict();

export const savedResponseSchema = z.object({ saved: z.literal(true) }).strict();
export const removedResponseSchema = z.object({ removed: z.literal(true) }).strict();

export type AgentRuntimeSettings = z.infer<typeof agentRuntimeSettingsSchema>;
export type AgentRuntimeSettingsUpdate = z.infer<
  typeof agentRuntimeSettingsUpdateSchema
>;
export type GitHubIntegration = z.infer<typeof githubIntegrationSchema>;
export type GitHubCredentialSource = z.infer<
  typeof githubCredentialSourceSchema
>;
export type JsonSource = z.infer<typeof jsonSourceSchema>;
export type JsonSourceVersion = z.infer<typeof jsonSourceVersionSchema>;
export type JsonSourceVersionsResponse = z.infer<
  typeof jsonSourceVersionsResponseSchema
>;
export type JsonSourceVersionDetail = z.infer<
  typeof jsonSourceVersionDetailSchema
>;
export type KnowledgeCheckpointSettings = z.infer<
  typeof knowledgeCheckpointSettingsSchema
>;
export type KnowledgeCheckpointSettingsUpdate = z.infer<
  typeof knowledgeCheckpointSettingsUpdateSchema
>;
export type RepositorySettings = z.infer<typeof repositorySettingsSchema>;
export type RepositorySettingsUpdate = z.infer<
  typeof repositorySettingsUpdateSchema
>;
