import { z } from "zod";

import { repositoryIdSchema, utcDateTimeSchema } from "./validation.js";
import { agentRuntimeCapabilitiesSchema } from "./agent.js";
import {
  repositoryRetentionSettingsSchema,
  repositoryRetentionSettingsUpdateSchema,
} from "./retention.js";

export const worktreeMaintenanceErrorSchema = z
  .object({
    slotPath: z.string().trim().min(1),
    message: z.string().trim().min(1),
  })
  .strict();

/** Repository-local worktree capacity policy and maintenance projection. */
export const repositoryWorktreeSettingsSchema = z
  .object({
    configuredSlots: z.number().int().min(1).max(8),
    idleCleanupTtlHours: z.number().int().positive(),
    physicalSlots: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    idle: z.number().int().nonnegative(),
    dirty: z.number().int().nonnegative(),
    pendingRetirement: z.number().int().nonnegative(),
    pendingRetirementPaths: z.array(z.string().trim().min(1)).optional(),
    dirtyPaths: z.array(z.string().trim().min(1)).optional(),
    busyPaths: z.array(z.string().trim().min(1)).optional(),
    errors: z.array(worktreeMaintenanceErrorSchema).optional(),
  })
  .strict();

export const repositoryWorktreeSettingsUpdateSchema = z
  .object({
    configuredSlots: z.number().int().min(1).max(8).optional(),
    idleCleanupTtlHours: z.number().int().positive().max(24 * 365).optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: "At least one worktree setting must be provided",
  });

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
    retention: repositoryRetentionSettingsSchema.default({
      automaticArchiveEnabled: false,
      archiveAfterDays: 7,
      includeMergedPrs: true,
      includeClosedPrs: true,
      includeClosedIssues: true,
      prunePayloadWhenArchived: true,
    }),
    worktrees: repositoryWorktreeSettingsSchema.default({
      configuredSlots: 1,
      idleCleanupTtlHours: 24,
      physicalSlots: 0,
      active: 0,
      idle: 0,
      dirty: 0,
      pendingRetirement: 0,
    }),
  })
  .strict();

export const repositorySettingsUpdateSchema = z
  .object({
    automaticSync: z.boolean().optional(),
    syncFrequencyMinutes: z.number().int().positive().optional(),
    syncLookbackDays: z.union([z.literal(7), z.literal(30)]).optional(),
    worktrees: repositoryWorktreeSettingsUpdateSchema.optional(),
    retention: repositoryRetentionSettingsUpdateSchema.optional(),
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

/** Knowledge repository backup policy and scheduler projection. */
export const knowledgeCheckpointSettingsSchema = z
  .object({
    autoCommit: z.boolean(),
    autoPush: z.boolean(),
    remote: z.string().trim().min(1),
    sourceRef: z.string().trim().min(1),
    remoteBranch: z.string().trim().min(1),
    checkpointIntervalMinutes: z.number().int().positive().nullable(),
    pushIntervalMinutes: z.number().int().positive().nullable(),
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
    sourceRef: z.string().trim().min(1).optional(),
    remoteBranch: z.string().trim().min(1).optional(),
    checkpointIntervalMinutes: z.number().int().positive().nullable().optional(),
    pushIntervalMinutes: z.number().int().positive().nullable().optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: "At least one setting must be provided",
  });

export const codeBackupSettingsSchema = z
  .object({
    repositoryPath: z.string().trim().min(1),
    /** Runtime-only probe result; never persisted in Settings V2. */
    available: z.boolean(),
    automaticCheckpoint: z.boolean(),
    checkpointIntervalMinutes: z.number().int().positive().nullable().optional(),
    automaticPush: z.boolean(),
    pushIntervalMinutes: z.number().int().positive().nullable().optional(),
    sourceRef: z.string().trim().min(1),
    remote: z.string().trim().min(1),
    remoteBranch: z.string().trim().min(1),
    lastCheckpointAt: utcDateTimeSchema.nullable().optional(),
    nextCheckpointAt: utcDateTimeSchema.nullable().optional(),
    lastPushAt: utcDateTimeSchema.nullable().optional(),
    nextPushAt: utcDateTimeSchema.nullable().optional(),
    lastError: z.string().nullable().optional(),
  })
  .strict();

export const codeBackupSettingsUpdateSchema = z
  .object({
    automaticCheckpoint: z.boolean().optional(),
    checkpointIntervalMinutes: z.number().int().positive().nullable().optional(),
    automaticPush: z.boolean().optional(),
    pushIntervalMinutes: z.number().int().positive().nullable().optional(),
    sourceRef: z.string().trim().min(1).optional(),
    remote: z.string().trim().min(1).optional(),
    remoteBranch: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: "At least one setting must be provided",
  });

/** Agent conversation archive policy and scheduler projection. */
export const agentArchiveSettingsSchema = z
  .object({
    archiveRepositoryPath: z.string().trim().min(1),
    enabled: z.boolean(),
    exportIntervalMinutes: z.number().int().positive().nullable().optional(),
    automaticPush: z.boolean(),
    pushIntervalMinutes: z.number().int().positive().nullable().optional(),
    sourceRef: z.string().trim().min(1),
    remote: z.string().trim().min(1),
    remoteBranch: z.string().trim().min(1),
    lastExportAt: utcDateTimeSchema.nullable().optional(),
    nextExportAt: utcDateTimeSchema.nullable().optional(),
    lastPushAt: utcDateTimeSchema.nullable().optional(),
    nextPushAt: utcDateTimeSchema.nullable().optional(),
    lastError: z.string().nullable().optional(),
  })
  .strict();

export const agentArchiveSettingsUpdateSchema = z
  .object({
    archiveRepositoryPath: z.string().trim().min(1).optional(),
    enabled: z.boolean().optional(),
    exportIntervalMinutes: z.number().int().positive().nullable().optional(),
    automaticPush: z.boolean().optional(),
    pushIntervalMinutes: z.number().int().positive().nullable().optional(),
    sourceRef: z.string().trim().min(1).optional(),
    remote: z.string().trim().min(1).optional(),
    remoteBranch: z.string().trim().min(1).optional(),
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

/**
 * Durable Settings V2 is deliberately smaller than the HTTP projections.
 * Runtime state belongs to scheduled_tasks, run history, and the adapters;
 * it must never be serialized into this document.
 */
export const settingsDocumentRepositoryWorktreeSchema = z
  .object({
    configuredSlots: z.number().int().min(1).max(8),
    idleCleanupTtlHours: z.number().int().positive().max(24 * 365),
  })
  .strict();

export const settingsDocumentRepositorySchema = z
  .object({
    automaticSync: z.boolean(),
    syncFrequencyMinutes: z.number().int().positive(),
    syncLookbackDays: z.union([z.literal(7), z.literal(30)]),
    retention: repositoryRetentionSettingsSchema,
    worktrees: settingsDocumentRepositoryWorktreeSchema,
  })
  .strict();

export const settingsDocumentGithubAccountSchema = z
  .object({
    login: z.string().trim().min(1),
    name: z.string().trim().min(1).nullable(),
  })
  .strict();

export const settingsDocumentGithubSchema = z
  .object({
    verifiedSource: githubCredentialSourceSchema.nullable(),
    account: settingsDocumentGithubAccountSchema.nullable(),
    rest: githubQuotaSchema.nullable(),
    graphql: githubQuotaSchema.nullable(),
    lastVerifiedAt: utcDateTimeSchema.nullable(),
  })
  .strict();

export const settingsDocumentAgentSchema = z
  .object({
    defaultProvider: z.string().trim().min(1).nullable(),
    defaultModel: z.string().trim().min(1).nullable(),
    defaultReasoning: z.string().trim().min(1).nullable(),
    retentionMinutes: z.number().int().nonnegative(),
  })
  .strict();

export const settingsDocumentKnowledgeBackupSchema = z
  .object({
    autoCommit: z.boolean(),
    autoPush: z.boolean(),
    remote: z.string().trim().min(1),
    sourceRef: z.string().trim().min(1),
    remoteBranch: z.string().trim().min(1),
    checkpointIntervalMinutes: z.number().int().positive().nullable(),
    pushIntervalMinutes: z.number().int().positive().nullable(),
  })
  .strict();

export const settingsDocumentCodeBackupSchema = z
  .object({
    automaticCheckpoint: z.boolean(),
    checkpointIntervalMinutes: z.number().int().positive().nullable(),
    automaticPush: z.boolean(),
    pushIntervalMinutes: z.number().int().positive().nullable(),
    sourceRef: z.string().trim().min(1),
    remote: z.string().trim().min(1),
    remoteBranch: z.string().trim().min(1),
  })
  .strict();

export const settingsDocumentAgentArchiveSchema = z
  .object({
    archiveRepositoryPath: z.string().trim().min(1),
    enabled: z.boolean(),
    exportIntervalMinutes: z.number().int().positive().nullable(),
    automaticPush: z.boolean(),
    pushIntervalMinutes: z.number().int().positive().nullable(),
    sourceRef: z.string().trim().min(1),
    remote: z.string().trim().min(1),
    remoteBranch: z.string().trim().min(1),
  })
  .strict();

export const settingsDocumentV2Schema = z
  .object({
    version: z.literal(2),
    repositories: z.record(z.string(), settingsDocumentRepositorySchema),
    github: settingsDocumentGithubSchema,
    agent: settingsDocumentAgentSchema,
    knowledgeBackup: settingsDocumentKnowledgeBackupSchema,
    codeBackup: settingsDocumentCodeBackupSchema,
    agentArchive: settingsDocumentAgentArchiveSchema,
  })
  .strict();

// Keep the PascalCase alias available for callers that name the persisted
// model after the document type rather than the Zod convention used here.
export const SettingsDocumentV2Schema = settingsDocumentV2Schema;

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
export type SettingsDocumentV2 = z.infer<typeof settingsDocumentV2Schema>;
export type SettingsDocumentRepository = z.infer<
  typeof settingsDocumentRepositorySchema
>;
export type SettingsDocumentKnowledgeBackup = z.infer<
  typeof settingsDocumentKnowledgeBackupSchema
>;
export type SettingsDocumentCodeBackup = z.infer<
  typeof settingsDocumentCodeBackupSchema
>;
export type SettingsDocumentAgentArchive = z.infer<
  typeof settingsDocumentAgentArchiveSchema
>;
export type CodeBackupSettings = z.infer<typeof codeBackupSettingsSchema>;
export type CodeBackupSettingsUpdate = z.infer<typeof codeBackupSettingsUpdateSchema>;
export type AgentArchiveSettings = z.infer<typeof agentArchiveSettingsSchema>;
export type AgentArchiveSettingsUpdate = z.infer<typeof agentArchiveSettingsUpdateSchema>;
export type RepositorySettings = z.infer<typeof repositorySettingsSchema>;
export type RepositoryRetentionSettings = z.infer<typeof repositoryRetentionSettingsSchema>;
export type RepositoryRetentionSettingsUpdate = z.infer<typeof repositoryRetentionSettingsUpdateSchema>;
export type RepositoryWorktreeSettings = z.infer<typeof repositoryWorktreeSettingsSchema>;
export type RepositoryWorktreeSettingsUpdate = z.infer<
  typeof repositoryWorktreeSettingsUpdateSchema
>;
export type RepositorySettingsUpdate = z.infer<
  typeof repositorySettingsUpdateSchema
>;
