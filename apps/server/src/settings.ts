import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import {
  getRepositorySyncStatus,
  getRepository,
  getScheduledTask,
  listRepositories,
  RepositoryNotFoundError,
  type DatabaseClient,
} from "@loongboard/database";
import {
  agentArchiveSettingsSchema,
  agentArchiveSettingsUpdateSchema,
  agentRuntimeSettingsSchema,
  agentRuntimeSettingsUpdateSchema,
  codeBackupSettingsSchema,
  codeBackupSettingsUpdateSchema,
  githubIntegrationSchema,
  githubTokenUpdateSchema,
  knowledgeCheckpointSettingsSchema,
  knowledgeCheckpointSettingsUpdateSchema,
  providerSecretUpdateSchema,
  repositorySettingsParamsSchema,
  repositorySettingsSchema,
  repositorySettingsUpdateSchema,
  savedResponseSchema,
  removedResponseSchema,
  settingsDocumentV3Schema,
  type AgentRuntimeSettings,
  type AgentRuntimeSettingsUpdate,
  type AgentArchiveSettings,
  type AgentArchiveSettingsUpdate,
  type CodeBackupSettings,
  type CodeBackupSettingsUpdate,
  type GitHubIntegration,
  type KnowledgeCheckpointSettings,
  type KnowledgeCheckpointSettingsUpdate,
  type RepositorySettings,
  type RepositorySettingsUpdate,
  type RepositoryWorktreeSettings,
  type SettingsDocumentV3,
} from "@loongboard/contracts";
import {
  GitHubCredentialService,
  type GitHubMetadataProvider,
} from "@loongboard/github";
import { atomicWrite, isWithinRoot } from "@loongboard/knowledge";
import type { FastifyInstance } from "fastify";

import { InvalidRequestError, parseRequest, sendParsed } from "./route-helpers.js";
import {
  migrateSettingsToV3,
  type SettingsDocumentScheduleOverrides,
  type SettingsDocumentDefaults,
} from "./settings-document.js";
import { validateCron } from "@loongboard/scheduler";
import { SYSTEM_TASK_IDS } from "./system-schedules.js";

/**
 * Runtime data needed by the control center. The Server owns this adapter so
 * the settings module does not depend on DSH types or copy its model catalog.
 */
export interface AgentRuntimeSettingsBridge {
  snapshot?: () => Promise<Partial<AgentRuntimeSnapshot> | null> | Partial<AgentRuntimeSnapshot> | null;
  /** Runtime hydration is synchronous by design and completes before timers arm. */
  update?: (patch: AgentRuntimeSettingsUpdate) => void;
  saveProviderSecret?: (provider: string, secret: string) => Promise<void> | void;
}

export interface AgentRuntimeSnapshot {
  status: string;
  version: string | null;
  profile: string | null;
  connected: boolean;
  capabilities: AgentRuntimeSettings["capabilities"];
}

/** Scheduler authority for repository sync preferences once a task exists. */
export interface RepositorySettingsBridge {
  get?: (
    repositoryId: string,
  ) => Promise<Partial<RepositorySettingsRuntime> | null> | Partial<RepositorySettingsRuntime> | null;
  update?: (
    repositoryId: string,
    patch: RepositorySettingsUpdate,
  ) => Promise<Partial<RepositorySettingsRuntime> | null> | Partial<RepositorySettingsRuntime> | null;
}

export type RepositorySettingsRuntime = Pick<RepositorySettings, "nextSyncAt">;

/** Worktree maintenance adapter; Settings remains the policy authority. */
export interface RepositoryWorktreeBridge {
  inspect?: (repositoryId: string) => Promise<Partial<RepositoryWorktreeRuntime> | null> | Partial<RepositoryWorktreeRuntime> | null;
  reconcile?: (repositoryId: string) => Promise<Partial<RepositoryWorktreeRuntime> | null> | Partial<RepositoryWorktreeRuntime> | null;
  cleanupUnused?: (repositoryId: string) => Promise<Partial<RepositoryWorktreeRuntime> | null> | Partial<RepositoryWorktreeRuntime> | null;
}

export type RepositoryWorktreeRuntime = Omit<
  RepositoryWorktreeSettings,
  "configuredSlots" | "idleCleanupTtlHours"
>;

/** Shared scheduler authority for the Knowledge-only checkpoint. */
export interface KnowledgeCheckpointBridge {
  get?: () =>
    | Promise<Partial<KnowledgeCheckpointRuntime> | null>
    | Partial<KnowledgeCheckpointRuntime>
    | null;
  update?: (
    patch: KnowledgeCheckpointSettingsUpdate,
  ) => Promise<Partial<KnowledgeCheckpointRuntime> | null> | Partial<KnowledgeCheckpointRuntime> | null;
  run?: () => Promise<void> | void;
  push?: () => Promise<void> | void;
}

export type KnowledgeCheckpointRuntime = Pick<
  KnowledgeCheckpointSettings,
  "nextRunAt" | "lastSuccessAt" | "lastError"
>;

/** Scheduler authority for the LoongBoard source repository backup tasks. */
export interface CodeBackupBridge {
  get?: () => Partial<CodeBackupRuntime> | null;
  update?: (
    patch: CodeBackupSettingsUpdate,
  ) => Promise<Partial<CodeBackupRuntime> | null> | Partial<CodeBackupRuntime> | null;
  runCheckpoint?: () => Promise<void> | void;
  runPush?: () => Promise<void> | void;
}

export type CodeBackupRuntime = Pick<
  CodeBackupSettings,
  | "repositoryPath"
  | "available"
  | "lastCheckpointAt"
  | "nextCheckpointAt"
  | "lastPushAt"
  | "nextPushAt"
  | "lastError"
>;

export const CODE_BACKUP_UNAVAILABLE_MESSAGE =
  "Code backup unavailable in container-image deployment.";

/** Scheduler authority for the normalized Agent conversation archive. */
export interface AgentArchiveBridge {
  get?: () => Promise<Partial<AgentArchiveRuntime> | null> | Partial<AgentArchiveRuntime> | null;
  update?: (
    patch: AgentArchiveSettingsUpdate,
  ) => Promise<Partial<AgentArchiveRuntime> | null> | Partial<AgentArchiveRuntime> | null;
  runExport?: () => Promise<void> | void;
  runPush?: () => Promise<void> | void;
}

export type AgentArchiveRuntime = Pick<
  AgentArchiveSettings,
  "lastExportAt" | "nextExportAt" | "lastPushAt" | "nextPushAt" | "lastError"
>;

export interface SettingsControllerOptions {
  database: DatabaseClient;
  /** Directory containing system.yaml and non-secret settings.json. */
  systemRoot: string;
  /** Runtime state directory; credential/provider secrets live below it. */
  statePath: string;
  environment?: NodeJS.ProcessEnv;
  github?: GitHubMetadataProvider;
  credential?: GitHubCredentialService;
  agent?: AgentRuntimeSettingsBridge;
  repositorySchedules?: RepositorySettingsBridge;
  worktrees?: RepositoryWorktreeBridge;
  checkpoint?: KnowledgeCheckpointBridge;
  codeBackup?: CodeBackupBridge;
  agentArchive?: AgentArchiveBridge;
  defaults?: {
    defaultProvider?: string | null;
    defaultModel?: string | null;
    defaultReasoning?: string | null;
    retentionMinutes?: number;
    checkpoint?: Partial<KnowledgeCheckpointSettings>;
  };
}

export interface SettingsRoutesDependencies {
  controller: SettingsController;
}

/**
 * Durable settings boundary used by the Settings control center.
 *
 * Non-secret values are kept in a dedicated settings.json beside the system
 * config so relative paths and unrelated system.yaml fields stay untouched.
 * GitHub and provider secrets are stored below the runtime state directory
 * with private permissions and are never included in returned projections.
 */
export class SettingsController {
  readonly settingsPath: string;
  readonly credential: GitHubCredentialService;

  private readonly database: DatabaseClient;
  private readonly systemRoot: string;
  private readonly statePath: string;
  private readonly github: GitHubMetadataProvider | undefined;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly agent: AgentRuntimeSettingsBridge | undefined;
  private readonly repositorySchedules: RepositorySettingsBridge | undefined;
  private readonly worktreeBridge: RepositoryWorktreeBridge | undefined;
  private readonly checkpointBridge: KnowledgeCheckpointBridge | undefined;
  private readonly codeBackupBridge: CodeBackupBridge | undefined;
  private readonly agentArchiveBridge: AgentArchiveBridge | undefined;
  private readonly defaults: NonNullable<SettingsControllerOptions["defaults"]>;

  constructor(options: SettingsControllerOptions) {
    if (options.systemRoot.trim().length === 0) {
      throw new Error("Settings systemRoot must not be empty");
    }
    if (options.statePath.trim().length === 0) {
      throw new Error("Settings statePath must not be empty");
    }
    this.database = options.database;
    this.systemRoot = resolve(options.systemRoot);
    this.statePath = resolve(options.statePath);
    this.settingsPath = resolve(this.systemRoot, "settings.json");
    if (!isWithinRoot(this.systemRoot, this.settingsPath)) {
      throw new Error("Settings path must stay inside systemRoot");
    }
    this.environment = options.environment ?? process.env;
    this.github = options.github;
    this.agent = options.agent;
    this.repositorySchedules = options.repositorySchedules;
    this.worktreeBridge = options.worktrees;
    this.checkpointBridge = options.checkpoint;
    this.codeBackupBridge = options.codeBackup;
    this.agentArchiveBridge = options.agentArchive;
    this.defaults = options.defaults ?? {};
    this.credential =
      options.credential ??
      new GitHubCredentialService({
        filePath: join(this.statePath, "github-credential.json"),
        environment: this.environment,
      });
    // Validate and normalize the durable boundary before the controller can
    // serve a read or accept a write. Missing and legacy documents are
    // rewritten atomically by readDocument; invalid input is left untouched.
    this.readDocument();
  }

  private documentDefaults(): SettingsDocumentDefaults {
    const repositories: SettingsDocumentDefaults["repositories"] = {};
    for (const repository of listRepositories(this.database)) {
      repositories[repository.id] = { configuredSlots: repository.worktreeSlots };
    }
    const checkpoint = this.defaults.checkpoint ?? {};
    return {
      repositories,
      agent: {
        defaultProvider: this.defaults.defaultProvider,
        defaultModel: this.defaults.defaultModel,
        defaultReasoning: this.defaults.defaultReasoning,
        retentionMinutes: this.defaults.retentionMinutes,
      },
      knowledgeBackup: {
        autoCommit: checkpoint.autoCommit,
        autoPush: checkpoint.autoPush,
        remote: checkpoint.remote,
        sourceRef: checkpoint.sourceRef,
        remoteBranch: checkpoint.remoteBranch,
        checkpointCron: checkpoint.checkpointCron,
        pushCron: checkpoint.pushCron,
      },
      agentArchive: {
        archiveRepositoryPath: resolve(this.systemRoot, "agent-history"),
      },
    };
  }

  async repository(repositoryId: string): Promise<RepositorySettings> {
    this.requireRepository(repositoryId);
    const document = this.readDocument();
    const stored = document.repositories[repositoryId];
    const sync = getRepositorySyncStatus(this.database, repositoryId);
    const persisted: RepositorySettings = {
      repositoryId,
      automaticSync: stored.automaticSync,
      syncCron: stored.syncCron,
      syncLookbackDays: stored.syncLookbackDays,
      nextSyncAt: null,
      lastSyncAt: latestTimestamp(sync.pullRequests.lastSuccessAt, sync.issues.lastSuccessAt),
      lastError: latestError(sync.pullRequests, sync.issues),
      retention: stored.retention,
      worktrees: {
        ...stored.worktrees,
        physicalSlots: 0,
        active: 0,
        idle: 0,
        dirty: 0,
        pendingRetirement: 0,
      },
    };
    const runtime = await this.repositorySchedules?.get?.(repositoryId);
    const status = await this.worktreeBridge?.inspect?.(repositoryId);
    return repositorySettingsSchema.parse({
      ...persisted,
      nextSyncAt: runtime?.nextSyncAt ?? null,
      repositoryId,
      worktrees: mergeWorktreeRuntime(persisted.worktrees, status),
    });
  }

  /** Synchronous fallback used during startup before scheduler timers arm. */
  repositorySettingsSync(repositoryId: string): RepositorySettings {
    this.requireRepository(repositoryId);
    const document = this.readDocument();
    const stored = document.repositories[repositoryId];
    const sync = getRepositorySyncStatus(this.database, repositoryId);
    return repositorySettingsSchema.parse({
      repositoryId,
      automaticSync: stored.automaticSync,
      syncCron: stored.syncCron,
      syncLookbackDays: stored.syncLookbackDays,
      nextSyncAt: null,
      lastSyncAt: latestTimestamp(sync.pullRequests.lastSuccessAt, sync.issues.lastSuccessAt),
      lastError: latestError(sync.pullRequests, sync.issues),
      retention: stored.retention,
      worktrees: {
        ...stored.worktrees,
        physicalSlots: 0,
        active: 0,
        idle: 0,
        dirty: 0,
        pendingRetirement: 0,
      },
    });
  }

  async updateRepository(
    repositoryId: string,
    patch: RepositorySettingsUpdate,
  ): Promise<RepositorySettings> {
    this.requireRepository(repositoryId);
    const validated = repositorySettingsUpdateSchema.parse(patch);
    if (validated.syncCron !== undefined) {
      assertValidCron(validated.syncCron, "syncCron");
    }
    const current = await this.repository(repositoryId);
    const policy = this.readDocument().repositories[repositoryId];
    const nextPolicy = {
      automaticSync: validated.automaticSync ?? policy.automaticSync,
      syncCron: validated.syncCron ?? policy.syncCron,
      syncLookbackDays: validated.syncLookbackDays ?? policy.syncLookbackDays,
      retention: { ...policy.retention, ...(validated.retention ?? {}) },
      worktrees: { ...policy.worktrees, ...(validated.worktrees ?? {}) },
    };
    this.updateDocument((document) => {
      document.repositories[repositoryId] = nextPolicy;
    });
    const runtime = await this.repositorySchedules?.update?.(repositoryId, {
      ...(validated.automaticSync === undefined ? {} : { automaticSync: validated.automaticSync }),
      ...(validated.syncCron === undefined ? {} : { syncCron: validated.syncCron }),
      ...(validated.syncLookbackDays === undefined ? {} : { syncLookbackDays: validated.syncLookbackDays }),
      ...(validated.retention === undefined
        ? {}
        : { retention: { ...current.retention, ...validated.retention } }),
    });
    const reconciled = validated.worktrees === undefined
      ? null
      : await this.worktreeBridge?.reconcile?.(repositoryId);
    return repositorySettingsSchema.parse({
      repositoryId,
      ...nextPolicy,
      nextSyncAt: runtime?.nextSyncAt ?? null,
      lastSyncAt: current.lastSyncAt,
      lastError: current.lastError,
      worktrees: {
        ...nextPolicy.worktrees,
        physicalSlots: current.worktrees.physicalSlots,
        active: current.worktrees.active,
        idle: current.worktrees.idle,
        dirty: current.worktrees.dirty,
        pendingRetirement: current.worktrees.pendingRetirement,
        ...(reconciled ?? {}),
      },
    });
  }

  async cleanupUnusedWorktrees(repositoryId: string): Promise<RepositorySettings> {
    this.requireRepository(repositoryId);
    const current = await this.repository(repositoryId);
    if (this.worktreeBridge?.cleanupUnused === undefined) return current;
    const result = await this.worktreeBridge.cleanupUnused(repositoryId);
    return repositorySettingsSchema.parse({
      ...current,
      worktrees: mergeWorktreeRuntime(current.worktrees, result),
    });
  }

  async githubIntegration(): Promise<GitHubIntegration> {
    const credential = await this.credential.summary();
    const stored = this.readDocument().github;
    const verification =
      credential.configured &&
      stored.verifiedSource !== null &&
      stored.verifiedSource === credential.source
        ? stored
        : null;
    return githubIntegrationSchema.parse({
      configured: credential.configured,
      source: credential.source,
      account: verification?.account ?? null,
      rest: verification?.rest ?? null,
      graphql: verification?.graphql ?? null,
      lastVerifiedAt: verification?.lastVerifiedAt ?? null,
    });
  }

  async verifyGithub(): Promise<GitHubIntegration> {
    const summary = await this.credential.summary();
    if (!summary.configured) {
      throw new InvalidRequestError("GitHub credential is not configured");
    }
    if (this.github?.checkConnection === undefined) {
      throw new InvalidRequestError("GitHub provider does not support connection checks");
    }
    const connection = await this.github.checkConnection();
    const now = new Date().toISOString();
    this.updateDocument((document) => {
      document.github = {
        verifiedSource: summary.source,
        account: connection.account,
        rest: connection.rest,
        graphql: connection.graphql,
        lastVerifiedAt: now,
      };
    });
    return this.githubIntegration();
  }

  async saveGithubToken(token: string): Promise<GitHubIntegration> {
    const input = githubTokenUpdateSchema.parse({ token });
    this.credential.save(input.token);
    this.github?.clearTokenCache?.();
    this.clearGithubVerification();
    return this.githubIntegration();
  }

  async removeGithubToken(): Promise<{ removed: true }> {
    this.credential.remove();
    this.github?.clearTokenCache?.();
    this.clearGithubVerification();
    return removedResponseSchema.parse({ removed: true });
  }

  async agentSettings(): Promise<AgentRuntimeSettings> {
    const stored = this.readDocument().agent;
    const runtime = await this.agent?.snapshot?.();
    const capabilities = runtime?.capabilities ?? null;
    return agentRuntimeSettingsSchema.parse({
      status: runtime?.status ?? (runtime?.connected === false ? "offline" : "ready"),
      version: runtime?.version ?? null,
      profile: runtime?.profile ?? null,
      connected: runtime?.connected ?? true,
      defaultProvider: stored.defaultProvider,
      defaultModel: stored.defaultModel,
      defaultReasoning: stored.defaultReasoning,
      retentionMinutes: stored.retentionMinutes,
      capabilities,
    });
  }

  /**
   * Apply persisted operational defaults to the already-created Agent runtime.
   * system.yaml supplies installation defaults; settings.json wins whenever a
   * user override exists. This is intentionally synchronous so startup can
   * hydrate the runtime before scheduler timers or HTTP requests are served.
   */
  hydrateAgentRuntime(): void {
    if (this.agent?.update === undefined) return;
    const stored = this.readDocument().agent;
    const patch: AgentRuntimeSettingsUpdate = {
      defaultProvider: stored.defaultProvider,
      defaultModel: stored.defaultModel,
      defaultReasoning: stored.defaultReasoning,
      retentionMinutes: stored.retentionMinutes,
    };
    this.agent.update(patch);
  }

  async updateAgent(patch: AgentRuntimeSettingsUpdate): Promise<AgentRuntimeSettings> {
    const validated = agentRuntimeSettingsUpdateSchema.parse(patch);
    this.updateDocument((document) => {
      const agent = { ...document.agent };
      if (validated.defaultProvider !== undefined) agent.defaultProvider = validated.defaultProvider;
      if (validated.defaultModel !== undefined) agent.defaultModel = validated.defaultModel;
      if (validated.defaultReasoning !== undefined) agent.defaultReasoning = validated.defaultReasoning;
      if (validated.retentionMinutes !== undefined) agent.retentionMinutes = validated.retentionMinutes;
      document.agent = agent;
    });
    await this.agent?.update?.(validated);
    return this.agentSettings();
  }

  async saveProviderSecret(provider: string, secret: string): Promise<{ saved: true }> {
    const input = providerSecretUpdateSchema.parse({ provider, secret });
    if (this.agent?.saveProviderSecret !== undefined) {
      await this.agent.saveProviderSecret(input.provider, input.secret);
    } else {
      this.saveLocalProviderSecret(input.provider, input.secret);
    }
    return savedResponseSchema.parse({ saved: true });
  }

  /**
   * Read locally stored provider secrets for the DSH native credential bridge.
   * This is an internal runtime callback; HTTP responses and persisted
   * settings projections never include these values.
   */
  readProviderSecrets(): Record<string, string> {
    const root = resolve(this.statePath, "provider-secrets");
    if (!existsSync(root)) return {};
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      return {};
    }
    const secrets: Record<string, string> = {};
    for (const entry of entries) {
      if (!entry.endsWith(".secret")) continue;
      const path = resolve(root, entry);
      if (!isWithinRoot(root, path)) continue;
      try {
        if (lstatSync(path).isSymbolicLink()) continue;
        const provider = decodeURIComponent(entry.slice(0, -7));
        const secret = readFileSync(path, "utf8");
        if (provider.trim().length > 0 && secret.trim().length > 0) {
          secrets[provider] = secret;
        }
      } catch {
        // A single unreadable secret must not prevent other providers from loading.
      }
    }
    return secrets;
  }

  async checkpointSettings(): Promise<KnowledgeCheckpointSettings> {
    const stored = this.readDocument().knowledgeBackup;
    const runtime = await this.checkpointBridge?.get?.();
    return knowledgeCheckpointSettingsSchema.parse({
      ...stored,
      nextRunAt: runtime?.nextRunAt ?? null,
      lastSuccessAt: runtime?.lastSuccessAt ?? null,
      lastError: runtime?.lastError ?? null,
    });
  }

  async codeBackupSettings(): Promise<CodeBackupSettings> {
    const stored = this.readDocument().codeBackup;
    const runtime = await this.codeBackupBridge?.get?.();
    return codeBackupSettingsSchema.parse({
      repositoryPath: runtime?.repositoryPath ?? this.systemRoot,
      available: runtime?.available ?? true,
      ...stored,
      nextCheckpointAt: runtime?.nextCheckpointAt ?? null,
      lastCheckpointAt: runtime?.lastCheckpointAt ?? null,
      nextPushAt: runtime?.nextPushAt ?? null,
      lastPushAt: runtime?.lastPushAt ?? null,
      lastError: runtime?.lastError ?? null,
    });
  }

  codeBackupSettingsSync(): CodeBackupSettings {
    const stored = this.readDocument().codeBackup;
    const runtime = this.codeBackupBridge?.get?.();
    return codeBackupSettingsSchema.parse({
      repositoryPath: runtime?.repositoryPath ?? this.systemRoot,
      available: runtime?.available ?? true,
      ...stored,
      nextCheckpointAt: null,
      lastCheckpointAt: null,
      nextPushAt: null,
      lastPushAt: null,
      lastError: null,
    });
  }

  async updateCodeBackup(patch: CodeBackupSettingsUpdate): Promise<CodeBackupSettings> {
    const validated = codeBackupSettingsUpdateSchema.parse(patch);
    if (validated.checkpointCron !== undefined) {
      assertValidCron(validated.checkpointCron, "checkpointCron");
    }
    if (validated.pushCron !== undefined) {
      assertValidCron(validated.pushCron, "pushCron");
    }
    const availabilityRuntime = await this.codeBackupBridge?.get?.();
    if (
      availabilityRuntime?.available === false &&
      (validated.automaticCheckpoint === true || validated.automaticPush === true)
    ) {
      throw new InvalidRequestError(CODE_BACKUP_UNAVAILABLE_MESSAGE);
    }
    const current = this.readDocument().codeBackup;
    const nextPolicy = { ...current, ...validated };
    this.updateDocument((document) => {
      document.codeBackup = nextPolicy;
    });
    const runtime = await this.codeBackupBridge?.update?.(validated);
    return codeBackupSettingsSchema.parse({
      repositoryPath:
        runtime?.repositoryPath ?? availabilityRuntime?.repositoryPath ?? this.systemRoot,
      available: runtime?.available ?? availabilityRuntime?.available ?? true,
      ...nextPolicy,
      nextCheckpointAt: runtime?.nextCheckpointAt ?? null,
      lastCheckpointAt: runtime?.lastCheckpointAt ?? null,
      nextPushAt: runtime?.nextPushAt ?? null,
      lastPushAt: runtime?.lastPushAt ?? null,
      lastError: runtime?.lastError ?? null,
    });
  }

  async runCodeBackupCheckpoint(): Promise<{ accepted: true }> {
    await this.assertCodeBackupAvailable();
    if (this.codeBackupBridge?.runCheckpoint === undefined) {
      throw new InvalidRequestError("Code backup checkpoint runner is not configured");
    }
    await this.codeBackupBridge.runCheckpoint();
    return { accepted: true };
  }

  async runCodeBackupPush(): Promise<{ accepted: true }> {
    await this.assertCodeBackupAvailable();
    if (this.codeBackupBridge?.runPush === undefined) {
      throw new InvalidRequestError("Code backup push runner is not configured");
    }
    await this.codeBackupBridge.runPush();
    return { accepted: true };
  }

  async agentArchiveSettings(): Promise<AgentArchiveSettings> {
    const stored = this.readDocument().agentArchive;
    const runtime = await this.agentArchiveBridge?.get?.();
    return agentArchiveSettingsSchema.parse({
      ...stored,
      nextExportAt: runtime?.nextExportAt ?? null,
      lastExportAt: runtime?.lastExportAt ?? null,
      nextPushAt: runtime?.nextPushAt ?? null,
      lastPushAt: runtime?.lastPushAt ?? null,
      lastError: runtime?.lastError ?? null,
    });
  }

  agentArchiveSettingsSync(): AgentArchiveSettings {
    const stored = this.readDocument().agentArchive;
    return agentArchiveSettingsSchema.parse({
      ...stored,
      nextExportAt: null,
      lastExportAt: null,
      nextPushAt: null,
      lastPushAt: null,
      lastError: null,
    });
  }

  async updateAgentArchive(patch: AgentArchiveSettingsUpdate): Promise<AgentArchiveSettings> {
    const validated = agentArchiveSettingsUpdateSchema.parse(patch);
    if (validated.exportCron !== undefined) {
      assertValidCron(validated.exportCron, "exportCron");
    }
    if (validated.pushCron !== undefined) {
      assertValidCron(validated.pushCron, "pushCron");
    }
    const current = this.readDocument().agentArchive;
    const nextPolicy = { ...current, ...validated };
    this.updateDocument((document) => {
      document.agentArchive = {
        ...nextPolicy,
      };
    });
    const runtime = await this.agentArchiveBridge?.update?.(validated);
    return agentArchiveSettingsSchema.parse({
      ...nextPolicy,
      nextExportAt: runtime?.nextExportAt ?? null,
      lastExportAt: runtime?.lastExportAt ?? null,
      nextPushAt: runtime?.nextPushAt ?? null,
      lastPushAt: runtime?.lastPushAt ?? null,
      lastError: runtime?.lastError ?? null,
    });
  }

  async runAgentArchiveExport(): Promise<{ accepted: true }> {
    if (this.agentArchiveBridge?.runExport === undefined) {
      throw new InvalidRequestError("Agent archive exporter is not configured");
    }
    await this.agentArchiveBridge.runExport();
    return { accepted: true };
  }

  async runAgentArchivePush(): Promise<{ accepted: true }> {
    if (this.agentArchiveBridge?.runPush === undefined) {
      throw new InvalidRequestError("Agent archive push runner is not configured");
    }
    await this.agentArchiveBridge.runPush();
    return { accepted: true };
  }

  /** Synchronous seed used while composing the runtime before timers start. */
  checkpointSettingsSync(): KnowledgeCheckpointSettings {
    const stored = this.readDocument().knowledgeBackup;
    return knowledgeCheckpointSettingsSchema.parse({
      ...stored,
      nextRunAt: null,
      lastSuccessAt: null,
      lastError: null,
    });
  }

  async updateCheckpoint(
    patch: KnowledgeCheckpointSettingsUpdate,
  ): Promise<KnowledgeCheckpointSettings> {
    const validated = knowledgeCheckpointSettingsUpdateSchema.parse(patch);
    if (validated.checkpointCron !== undefined) {
      assertValidCron(validated.checkpointCron, "checkpointCron");
    }
    if (validated.pushCron !== undefined) {
      assertValidCron(validated.pushCron, "pushCron");
    }
    const current = this.readDocument().knowledgeBackup;
    const nextPolicy = { ...current, ...validated };
    this.updateDocument((document) => {
      document.knowledgeBackup = nextPolicy;
    });
    const runtime = await this.checkpointBridge?.update?.(validated);
    return knowledgeCheckpointSettingsSchema.parse({
      ...nextPolicy,
      nextRunAt: runtime?.nextRunAt ?? null,
      lastSuccessAt: runtime?.lastSuccessAt ?? null,
      lastError: runtime?.lastError ?? null,
    });
  }

  async runCheckpoint(): Promise<{ accepted: true }> {
    if (this.checkpointBridge?.run === undefined) {
      throw new InvalidRequestError("Knowledge checkpoint runner is not configured");
    }
    await this.checkpointBridge.run();
    return { accepted: true };
  }

  async pushCheckpoint(): Promise<{ accepted: true }> {
    if (this.checkpointBridge?.push === undefined) {
      throw new InvalidRequestError("Knowledge checkpoint runner is not configured");
    }
    await this.checkpointBridge.push();
    return { accepted: true };
  }

  private requireRepository(repositoryId: string): void {
    if (getRepository(this.database, repositoryId) === null) {
      throw new RepositoryNotFoundError(repositoryId);
    }
  }

  private async assertCodeBackupAvailable(): Promise<void> {
    const runtime = await this.codeBackupBridge?.get?.();
    if (runtime?.available === false) {
      throw new InvalidRequestError(CODE_BACKUP_UNAVAILABLE_MESSAGE);
    }
  }

  private clearGithubVerification(): void {
    this.updateDocument((document) => {
      document.github = {
        verifiedSource: null,
        account: null,
        rest: null,
        graphql: null,
        lastVerifiedAt: null,
      };
    });
  }

  private saveLocalProviderSecret(provider: string, secret: string): void {
    const directory = resolve(this.statePath, "provider-secrets");
    const path = safeProviderPath(directory, provider);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    ensureRegularTarget(path);
    atomicWrite(path, secret);
    chmodSync(path, 0o600);
  }

  private migrationScheduleOverrides(
    repositoryIds: readonly string[],
  ): SettingsDocumentScheduleOverrides {
    const cron = (taskId: string): string | undefined =>
      getScheduledTask(this.database, taskId)?.cronExpression;
    const repositorySyncCron: Record<string, string> = {};
    for (const repositoryId of repositoryIds) {
      const expression = cron(SYSTEM_TASK_IDS.repositorySync(repositoryId));
      if (expression !== undefined) repositorySyncCron[repositoryId] = expression;
    }
    return {
      repositorySyncCron,
      knowledgeCheckpointCron: cron(SYSTEM_TASK_IDS.knowledgeCheckpoint),
      knowledgePushCron: cron(SYSTEM_TASK_IDS.knowledgePush),
      codeCheckpointCron: cron(SYSTEM_TASK_IDS.codeCheckpoint),
      codePushCron: cron(SYSTEM_TASK_IDS.codePush),
      agentArchiveExportCron: cron(SYSTEM_TASK_IDS.agentArchiveCheckpoint),
      agentArchivePushCron: cron(SYSTEM_TASK_IDS.agentArchivePush),
    };
  }

  private readDocument(): SettingsDocumentV3 {
    if (!existsSync(this.settingsPath)) {
      const document = migrateSettingsToV3(undefined, this.documentDefaults());
      ensureRegularTarget(this.settingsPath);
      atomicWrite(this.settingsPath, `${JSON.stringify(document, null, 2)}\n`);
      return document;
    }
    ensureRegularTarget(this.settingsPath);
    let raw: string;
    try {
      raw = readFileSync(this.settingsPath, "utf8");
    } catch {
      throw new Error("Failed to read settings.json");
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw) as unknown;
    } catch {
      throw new Error("settings.json is invalid JSON");
    }
    if (!isRecord(decoded)) throw new Error("settings.json must contain an object");
    const schedules = decoded.version === 2
      ? this.migrationScheduleOverrides(
          Object.keys(isRecord(decoded.repositories) ? decoded.repositories : {}),
        )
      : {};
    let document = migrateSettingsToV3(decoded, this.documentDefaults(), schedules);
    const migrated = decoded.version !== 3;
    if (migrated) {
      ensureRegularTarget(this.settingsPath);
      atomicWrite(this.settingsPath, `${JSON.stringify(document, null, 2)}\n`);
      return document;
    }
    const defaults = this.documentDefaults();
    let addedRepository = false;
    for (const repository of Object.keys(defaults.repositories ?? {})) {
      if (document.repositories[repository] !== undefined) continue;
      const repositoryDocument = migrateSettingsToV3(
        { version: 1, repositories: { [repository]: {} } },
        { repositories: { [repository]: defaults.repositories?.[repository] ?? {} } },
      );
      document = {
        ...document,
        repositories: {
          ...document.repositories,
          [repository]: repositoryDocument.repositories[repository],
        },
      };
      addedRepository = true;
    }
    if (addedRepository) {
      document = settingsDocumentV3Schema.parse(document);
      ensureRegularTarget(this.settingsPath);
      atomicWrite(this.settingsPath, `${JSON.stringify(document, null, 2)}\n`);
    }
    return document;
  }

  private updateDocument(mutator: (document: SettingsDocumentV3) => void): void {
    const document = this.readDocument();
    mutator(document);
    const validated = settingsDocumentV3Schema.parse(document);
    ensureRegularTarget(this.settingsPath);
    atomicWrite(this.settingsPath, `${JSON.stringify(validated, null, 2)}\n`);
  }
}

export function registerSettingsRoutes(
  app: FastifyInstance,
  dependencies: SettingsRoutesDependencies,
): void {
  const { controller } = dependencies;

  app.get("/api/repositories/:id/settings", async (request, reply) => {
    const { id } = parseRequest(repositorySettingsParamsSchema, request.params);
    return sendParsed(reply, 200, repositorySettingsSchema, await controller.repository(id));
  });

  app.put("/api/repositories/:id/settings", async (request, reply) => {
    const { id } = parseRequest(repositorySettingsParamsSchema, request.params);
    const body = parseRequest(repositorySettingsUpdateSchema, request.body);
    return sendParsed(reply, 200, repositorySettingsSchema, await controller.updateRepository(id, body));
  });

  app.post("/api/repositories/:id/settings/worktrees/cleanup", async (request, reply) => {
    const { id } = parseRequest(repositorySettingsParamsSchema, request.params);
    return sendParsed(reply, 200, repositorySettingsSchema, await controller.cleanupUnusedWorktrees(id));
  });

  app.get("/api/settings/integrations/github", async (_request, reply) => {
    return sendParsed(reply, 200, githubIntegrationSchema, await controller.githubIntegration());
  });

  app.post("/api/settings/integrations/github/verify", async (_request, reply) => {
    return sendParsed(reply, 200, githubIntegrationSchema, await controller.verifyGithub());
  });

  app.put("/api/settings/integrations/github", async (request, reply) => {
    const body = parseRequest(githubTokenUpdateSchema, request.body);
    return sendParsed(reply, 200, githubIntegrationSchema, await controller.saveGithubToken(body.token));
  });

  app.delete("/api/settings/integrations/github", async (_request, reply) => {
    return sendParsed(reply, 200, removedResponseSchema, await controller.removeGithubToken());
  });

  app.get("/api/settings/agent", async (_request, reply) => {
    return sendParsed(reply, 200, agentRuntimeSettingsSchema, await controller.agentSettings());
  });

  app.put("/api/settings/agent", async (request, reply) => {
    const body = parseRequest(agentRuntimeSettingsUpdateSchema, request.body);
    return sendParsed(reply, 200, agentRuntimeSettingsSchema, await controller.updateAgent(body));
  });

  app.put("/api/settings/agent/providers", async (request, reply) => {
    const body = parseRequest(providerSecretUpdateSchema, request.body);
    return sendParsed(reply, 200, savedResponseSchema, await controller.saveProviderSecret(body.provider, body.secret));
  });

  app.get("/api/settings/knowledge-checkpoint", async (_request, reply) => {
    return sendParsed(reply, 200, knowledgeCheckpointSettingsSchema, await controller.checkpointSettings());
  });

  app.get("/api/settings/code-backup", async (_request, reply) => {
    return sendParsed(reply, 200, codeBackupSettingsSchema, await controller.codeBackupSettings());
  });

  app.put("/api/settings/code-backup", async (request, reply) => {
    const body = parseRequest(codeBackupSettingsUpdateSchema, request.body);
    return sendParsed(reply, 200, codeBackupSettingsSchema, await controller.updateCodeBackup(body));
  });

  app.post("/api/settings/code-backup/checkpoint", async (_request, reply) => {
    await controller.runCodeBackupCheckpoint();
    return sendParsed(reply, 200, savedResponseSchema, { saved: true });
  });

  app.post("/api/settings/code-backup/push", async (_request, reply) => {
    await controller.runCodeBackupPush();
    return sendParsed(reply, 200, savedResponseSchema, { saved: true });
  });

  app.get("/api/settings/agent-archive", async (_request, reply) => {
    return sendParsed(reply, 200, agentArchiveSettingsSchema, await controller.agentArchiveSettings());
  });

  app.put("/api/settings/agent-archive", async (request, reply) => {
    const body = parseRequest(agentArchiveSettingsUpdateSchema, request.body);
    return sendParsed(reply, 200, agentArchiveSettingsSchema, await controller.updateAgentArchive(body));
  });

  app.post("/api/settings/agent-archive/export", async (_request, reply) => {
    await controller.runAgentArchiveExport();
    return sendParsed(reply, 200, savedResponseSchema, { saved: true });
  });

  app.post("/api/settings/agent-archive/push", async (_request, reply) => {
    await controller.runAgentArchivePush();
    return sendParsed(reply, 200, savedResponseSchema, { saved: true });
  });

  app.put("/api/settings/knowledge-checkpoint", async (request, reply) => {
    const body = parseRequest(knowledgeCheckpointSettingsUpdateSchema, request.body);
    return sendParsed(reply, 200, knowledgeCheckpointSettingsSchema, await controller.updateCheckpoint(body));
  });

  app.post("/api/settings/knowledge-checkpoint/run", async (_request, reply) => {
    await controller.runCheckpoint();
    return sendParsed(reply, 200, savedResponseSchema, { saved: true });
  });

  app.post("/api/settings/knowledge-checkpoint/push", async (_request, reply) => {
    await controller.pushCheckpoint();
    return sendParsed(reply, 200, savedResponseSchema, { saved: true });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertValidCron(expression: string, field: string): void {
  try {
    validateCron(expression);
  } catch (error) {
    throw new InvalidRequestError(
      `Invalid ${field}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function latestTimestamp(...timestamps: Array<string | null>): string | null {
  return timestamps
    .filter((value): value is string => value !== null)
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
}

function latestError(...states: Array<{ lastAttemptAt: string | null; lastError: string | null }>): string | null {
  const failed = states
    .filter((state) => state.lastError !== null)
    .sort((left, right) => Date.parse(right.lastAttemptAt ?? "") - Date.parse(left.lastAttemptAt ?? ""));
  return failed[0]?.lastError ?? null;
}

function mergeWorktreeRuntime(
  policy: RepositoryWorktreeSettings,
  runtime: Partial<RepositoryWorktreeRuntime> | null | undefined,
): RepositoryWorktreeSettings {
  if (runtime === null || runtime === undefined) return policy;
  return {
    ...policy,
    physicalSlots: runtime.physicalSlots ?? policy.physicalSlots,
    active: runtime.active ?? policy.active,
    idle: runtime.idle ?? policy.idle,
    dirty: runtime.dirty ?? policy.dirty,
    pendingRetirement: runtime.pendingRetirement ?? policy.pendingRetirement,
    ...(runtime.pendingRetirementPaths === undefined
      ? {}
      : { pendingRetirementPaths: runtime.pendingRetirementPaths }),
    ...(runtime.dirtyPaths === undefined ? {} : { dirtyPaths: runtime.dirtyPaths }),
    ...(runtime.busyPaths === undefined ? {} : { busyPaths: runtime.busyPaths }),
    ...(runtime.errors === undefined ? {} : { errors: runtime.errors }),
  };
}

function safeProviderPath(root: string, provider: string): string {
  const name = /^[A-Za-z0-9._-]+$/.test(provider) && provider !== "." && provider !== ".."
    ? provider
    : encodeURIComponent(provider);
  const path = resolve(root, `${name}.secret`);
  if (!isWithinRoot(root, path)) throw new InvalidRequestError("Provider name maps outside state root");
  return path;
}

function ensureRegularTarget(path: string): void {
  if (!existsSync(path)) return;
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new InvalidRequestError("Settings target must not be a symlink");
    }
  } catch (error) {
    if (error instanceof InvalidRequestError) throw error;
    throw new InvalidRequestError("Settings target cannot be inspected");
  }
}
