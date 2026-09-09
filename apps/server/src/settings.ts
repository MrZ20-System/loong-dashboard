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
  RepositoryNotFoundError,
  type DatabaseClient,
} from "@loongboard/database";
import {
  agentRuntimeSettingsSchema,
  agentRuntimeSettingsUpdateSchema,
  githubIntegrationSchema,
  githubTokenUpdateSchema,
  jsonSourceSchema,
  knowledgeCheckpointSettingsSchema,
  knowledgeCheckpointSettingsUpdateSchema,
  providerSecretUpdateSchema,
  repositorySettingsParamsSchema,
  repositorySettingsSchema,
  repositorySettingsUpdateSchema,
  savedResponseSchema,
  removedResponseSchema,
  type AgentRuntimeSettings,
  type AgentRuntimeSettingsUpdate,
  type GitHubIntegration,
  type JsonSource,
  type KnowledgeCheckpointSettings,
  type KnowledgeCheckpointSettingsUpdate,
  type RepositorySettings,
  type RepositorySettingsUpdate,
} from "@loongboard/contracts";
import {
  GitHubCredentialService,
  type GitHubCredentialSource,
  type GitHubConnectionStatus,
  type GitHubMetadataProvider,
} from "@loongboard/github";
import { atomicWrite, isWithinRoot } from "@loongboard/knowledge";
import type { FastifyInstance } from "fastify";

import { InvalidRequestError, parseRequest, sendParsed } from "./route-helpers.js";

/**
 * Runtime data needed by the control center. The Server owns this adapter so
 * the settings module does not depend on DSH types or copy its model catalog.
 */
export interface AgentRuntimeSettingsBridge {
  snapshot?: () => Promise<Partial<AgentRuntimeSnapshot> | null> | Partial<AgentRuntimeSnapshot> | null;
  update?: (patch: AgentRuntimeSettingsUpdate) => Promise<void> | void;
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
  ) => Promise<Partial<RepositorySettings> | null> | Partial<RepositorySettings> | null;
  update?: (
    repositoryId: string,
    patch: RepositorySettingsUpdate,
  ) => Promise<Partial<RepositorySettings> | null> | Partial<RepositorySettings> | null;
}

/** Shared scheduler authority for the Knowledge-only checkpoint. */
export interface KnowledgeCheckpointBridge {
  get?: () =>
    | Promise<Partial<KnowledgeCheckpointSettings> | null>
    | Partial<KnowledgeCheckpointSettings>
    | null;
  update?: (
    patch: KnowledgeCheckpointSettingsUpdate,
  ) => Promise<Partial<KnowledgeCheckpointSettings> | null> | Partial<KnowledgeCheckpointSettings> | null;
  run?: () => Promise<void> | void;
  push?: () => Promise<void> | void;
}

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
  checkpoint?: KnowledgeCheckpointBridge;
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

interface SettingsDocument {
  [key: string]: unknown;
  version?: number;
  repositories?: Record<string, unknown>;
  github?: Record<string, unknown>;
  agent?: Record<string, unknown>;
  checkpoint?: Record<string, unknown>;
  providers?: Record<string, unknown>;
}

const DEFAULT_RETENTION_MINUTES = 120;
const DEFAULT_SYNC_FREQUENCY_MINUTES = 60;
const DEFAULT_SYNC_LOOKBACK_DAYS = 30;
const DEFAULT_CHECKPOINT: KnowledgeCheckpointSettings = {
  autoCommit: false,
  autoPush: false,
  remote: "origin",
  branch: "main",
  intervalMinutes: null,
  nextRunAt: null,
  lastSuccessAt: null,
  lastError: null,
};

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
  private readonly checkpointBridge: KnowledgeCheckpointBridge | undefined;
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
    this.checkpointBridge = options.checkpoint;
    this.defaults = options.defaults ?? {};
    this.credential =
      options.credential ??
      new GitHubCredentialService({
        filePath: join(this.statePath, "github-credential.json"),
        environment: this.environment,
      });
  }

  async repository(repositoryId: string): Promise<RepositorySettings> {
    this.requireRepository(repositoryId);
    const document = this.readDocument();
    const stored = readRecord(document.repositories?.[repositoryId]);
    const sync = getRepositorySyncStatus(this.database, repositoryId);
    const persisted: RepositorySettings = {
      repositoryId,
      automaticSync: readBoolean(stored.automaticSync, false),
      syncFrequencyMinutes: readPositiveInteger(
        stored.syncFrequencyMinutes,
        DEFAULT_SYNC_FREQUENCY_MINUTES,
      ),
      syncLookbackDays: readSyncLookbackDays(stored.syncLookbackDays),
      nextSyncAt: readNullableString(stored.nextSyncAt),
      lastSyncAt: latestTimestamp(sync.pullRequests.lastSuccessAt, sync.issues.lastSuccessAt),
      lastError: latestError(sync.pullRequests, sync.issues),
    };
    const authoritative = await this.repositorySchedules?.get?.(repositoryId);
    return repositorySettingsSchema.parse({
      ...persisted,
      ...(authoritative ?? {}),
      repositoryId,
    });
  }

  /** Synchronous fallback used during startup before scheduler timers arm. */
  repositorySettingsSync(repositoryId: string): RepositorySettings {
    this.requireRepository(repositoryId);
    const document = this.readDocument();
    const stored = readRecord(document.repositories?.[repositoryId]);
    const sync = getRepositorySyncStatus(this.database, repositoryId);
    return repositorySettingsSchema.parse({
      repositoryId,
      automaticSync: readBoolean(stored.automaticSync, false),
      syncFrequencyMinutes: readPositiveInteger(
        stored.syncFrequencyMinutes,
        DEFAULT_SYNC_FREQUENCY_MINUTES,
      ),
      syncLookbackDays: readSyncLookbackDays(stored.syncLookbackDays),
      nextSyncAt: readNullableString(stored.nextSyncAt),
      lastSyncAt: latestTimestamp(sync.pullRequests.lastSuccessAt, sync.issues.lastSuccessAt),
      lastError: latestError(sync.pullRequests, sync.issues),
    });
  }

  async updateRepository(
    repositoryId: string,
    patch: RepositorySettingsUpdate,
  ): Promise<RepositorySettings> {
    this.requireRepository(repositoryId);
    const validated = repositorySettingsUpdateSchema.parse(patch);
    const current = await this.repository(repositoryId);
    const authoritative = await this.repositorySchedules?.update?.(
      repositoryId,
      validated,
    );
    const next = repositorySettingsSchema.parse({
      ...current,
      ...validated,
      ...(authoritative ?? {}),
      repositoryId,
    });
    this.updateDocument((document) => {
      const repositories = readObject(document.repositories);
      repositories[repositoryId] = {
        ...readRecord(repositories[repositoryId]),
        automaticSync: next.automaticSync,
        syncFrequencyMinutes: next.syncFrequencyMinutes,
        syncLookbackDays: next.syncLookbackDays,
        ...(next.nextSyncAt === undefined ? {} : { nextSyncAt: next.nextSyncAt }),
      };
      document.repositories = repositories;
    });
    return next;
  }

  async githubIntegration(): Promise<GitHubIntegration> {
    const credential = await this.credential.summary();
    const stored = readRecord(this.readDocument().github);
    const verifiedSource = readCredentialSource(stored.verifiedSource);
    const verification =
      credential.configured &&
      verifiedSource !== undefined &&
      verifiedSource === credential.source
        ? stored
        : {};
    return githubIntegrationSchema.parse({
      configured: credential.configured,
      source: credential.source,
      account: readAccount(verification.account),
      rest: readQuota(verification.rest),
      graphql: readQuota(verification.graphql),
      lastVerifiedAt: readNullableString(verification.lastVerifiedAt),
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
        ...readRecord(document.github),
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
    const stored = readRecord(this.readDocument().agent);
    const runtime = await this.agent?.snapshot?.();
    const capabilities = runtime?.capabilities ?? null;
    return agentRuntimeSettingsSchema.parse({
      status: runtime?.status ?? (runtime?.connected === false ? "offline" : "ready"),
      version: runtime?.version ?? null,
      profile: runtime?.profile ?? null,
      connected: runtime?.connected ?? true,
      defaultProvider: readNullableString(
        stored.defaultProvider,
        this.defaults.defaultProvider ?? null,
      ),
      defaultModel: readNullableString(
        stored.defaultModel,
        this.defaults.defaultModel ?? null,
      ),
      defaultReasoning: readNullableString(
        stored.defaultReasoning,
        this.defaults.defaultReasoning ?? null,
      ),
      retentionMinutes: readNonNegativeInteger(
        stored.retentionMinutes,
        this.defaults.retentionMinutes ?? DEFAULT_RETENTION_MINUTES,
      ),
      capabilities,
    });
  }

  async updateAgent(patch: AgentRuntimeSettingsUpdate): Promise<AgentRuntimeSettings> {
    const validated = agentRuntimeSettingsUpdateSchema.parse(patch);
    await this.agent?.update?.(validated);
    this.updateDocument((document) => {
      const agent = readRecord(document.agent);
      for (const key of [
        "defaultProvider",
        "defaultModel",
        "defaultReasoning",
        "retentionMinutes",
      ] as const) {
        const value = validated[key];
        if (value !== undefined) agent[key] = value;
      }
      document.agent = agent;
    });
    return this.agentSettings();
  }

  async saveProviderSecret(provider: string, secret: string): Promise<{ saved: true }> {
    const input = providerSecretUpdateSchema.parse({ provider, secret });
    if (this.agent?.saveProviderSecret !== undefined) {
      await this.agent.saveProviderSecret(input.provider, input.secret);
    } else {
      this.saveLocalProviderSecret(input.provider, input.secret);
    }
    this.updateDocument((document) => {
      const providers = readObject(document.providers);
      providers[input.provider] = {
        ...readRecord(providers[input.provider]),
        configured: true,
        updatedAt: new Date().toISOString(),
      };
      document.providers = providers;
    });
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
    const stored = readRecord(this.readDocument().checkpoint);
    const authoritative = await this.checkpointBridge?.get?.();
    return knowledgeCheckpointSettingsSchema.parse({
      ...DEFAULT_CHECKPOINT,
      ...(this.defaults.checkpoint ?? {}),
      ...stored,
      ...(authoritative ?? {}),
    });
  }

  /** Synchronous seed used while composing the runtime before timers start. */
  checkpointSettingsSync(): KnowledgeCheckpointSettings {
    const stored = readRecord(this.readDocument().checkpoint);
    return knowledgeCheckpointSettingsSchema.parse({
      ...DEFAULT_CHECKPOINT,
      ...(this.defaults.checkpoint ?? {}),
      ...stored,
    });
  }

  async updateCheckpoint(
    patch: KnowledgeCheckpointSettingsUpdate,
  ): Promise<KnowledgeCheckpointSettings> {
    const validated = knowledgeCheckpointSettingsUpdateSchema.parse(patch);
    const current = await this.checkpointSettings();
    const next = knowledgeCheckpointSettingsSchema.parse({
      ...current,
      ...validated,
    });
    const authoritative = await this.checkpointBridge?.update?.(next);
    const persisted = knowledgeCheckpointSettingsSchema.parse({
      ...next,
      ...(authoritative ?? {}),
    });
    this.updateDocument((document) => {
      document.checkpoint = {
        ...readRecord(document.checkpoint),
        autoCommit: persisted.autoCommit,
        autoPush: persisted.autoPush,
        remote: persisted.remote,
        branch: persisted.branch,
        intervalMinutes: persisted.intervalMinutes ?? null,
      };
    });
    return persisted;
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

  private clearGithubVerification(): void {
    this.updateDocument((document) => {
      const github = readRecord(document.github);
      delete github.verifiedSource;
      delete github.account;
      delete github.rest;
      delete github.graphql;
      delete github.lastVerifiedAt;
      document.github = github;
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

  private readDocument(): SettingsDocument {
    if (!existsSync(this.settingsPath)) return { version: 1 };
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
    return decoded as SettingsDocument;
  }

  private updateDocument(mutator: (document: SettingsDocument) => void): void {
    const document = this.readDocument();
    mutator(document);
    document.version = 1;
    ensureRegularTarget(this.settingsPath);
    atomicWrite(this.settingsPath, `${JSON.stringify(document, null, 2)}\n`);
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

function readRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {};
}

function readObject(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readPositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function readSyncLookbackDays(value: unknown): 7 | 30 {
  return value === 7 || value === 30 ? value : DEFAULT_SYNC_LOOKBACK_DAYS;
}

function readNonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : fallback;
}

function readNullableString(value: unknown, fallback?: string | null): string | null {
  if (value === null) return null;
  return typeof value === "string" && value.trim().length > 0
    ? value
    : fallback ?? null;
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

function readCredentialSource(value: unknown): GitHubCredentialSource | undefined {
  return value === "settings" ||
    value === "GH_TOKEN" ||
    value === "GITHUB_TOKEN" ||
    value === "gh" ||
    value === "none"
    ? value
    : undefined;
}

function readAccount(value: unknown): GitHubIntegration["account"] {
  if (!isRecord(value) || typeof value.login !== "string" || value.login.trim().length === 0) {
    return null;
  }
  return {
    login: value.login,
    ...(value.name === null || typeof value.name === "string" ? { name: value.name } : {}),
  };
}

function readQuota(value: unknown): GitHubIntegration["rest"] {
  if (!isRecord(value)) return null;
  const remaining = value.remaining;
  const limit = value.limit;
  const resetAt = value.resetAt;
  if (
    typeof remaining !== "number" || !Number.isInteger(remaining) || remaining < 0 ||
    typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0 ||
    !(resetAt === null || typeof resetAt === "string")
  ) {
    return null;
  }
  return { remaining, limit, resetAt };
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
