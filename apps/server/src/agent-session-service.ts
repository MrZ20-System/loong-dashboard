import { lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  AgentRuntimeHost,
  type AgentRuntime,
  type AgentSessionSpec,
} from "@loongboard/agent-runtime";
import {
  createAgentSession,
  deleteAgentSession,
  findAgentSession,
  getRepository,
  listAgentMessages,
  listAgentSessions,
  listBusyWorkspacePaths,
  listWorktreeSlots,
  recordWorktreeSlotUse,
  requireAgentSession,
  setGeneratedAgentSessionTitleIfProvisional,
  touchAgentSession,
  updateAgentSession,
  type DatabaseClient,
} from "@loongboard/database";
import type {
  AgentRuntimeCapabilities,
  AgentScope,
  AgentSessionCreate,
  AgentSessionSummary,
  AgentSessionUpdate,
  AgentSessionsQuery,
} from "@loongboard/contracts";
import { WorktreePool, type AllocatedSlot } from "@loongboard/git-workspace";

import { AgentSessionHomeCleaner } from "./agent-session-home.js";

/** Small, explicit runtime default state shared with the facade. */
export interface AgentRuntimeDefaults {
  provider: string;
  model: string;
  reasoningEffort: string;
  idleProcessMinutes: number;
}

export const MAX_WORKTREE_SLOTS = 16;
export const AGENT_TITLE_RETRY_COOLDOWN_MS = 2_000;

export type WorktreeSlotCapacityResolver = (
  repositoryId: string,
  configuredSlots: number,
) => number | Promise<number>;

/** One session view plus its PR revision snapshot. */
export interface AgentSessionView {
  session: AgentSessionSummary;
  targetRevision: string | null;
  workspaceRevision: string | null;
}

export interface AgentSessionServiceOptions {
  database: DatabaseClient;
  host: AgentRuntimeHost;
  sessionHomeCleaner: AgentSessionHomeCleaner;
  worktreePool: WorktreePool;
  agentSessionsPath: string;
  worktreesPath: string;
  knowledgePath?: string;
  /** Personal Data repository root for general and knowledge sessions. */
  personalDataPath?: string;
  domainWorkspaceRoot?: string;
  worktreeSlotCapacity?: WorktreeSlotCapacityResolver;
  defaults: AgentRuntimeDefaults;
  now?: () => Date;
}

function requireEnabledRepository(database: DatabaseClient, repositoryId: string) {
  const repository = getRepository(database, repositoryId);
  if (repository === null) {
    throw new Error(`Repository is missing or disabled: ${repositoryId}`);
  }
  return repository;
}

/** Canonical in-process key for one session scope (StrictMode convergence). */
function sessionScopeKey(scope: AgentScope): string {
  if (scope.kind === "pr") {
    return `pr:${scope.repositoryId ?? ""}:${scope.prNumber ?? ""}:${scope.targetSha ?? ""}`;
  }
  if (scope.kind === "issue") {
    return `issue:${scope.repositoryId ?? ""}:${scope.issueNumber ?? ""}`;
  }
  if (scope.kind === "knowledge") {
    return `knowledge:${scope.knowledgeDocumentId ?? ""}`;
  }
  if (scope.kind === "repository") {
    return `repository:${scope.repositoryId ?? ""}:${scope.route ?? ""}`;
  }
  if (scope.kind === "domain") {
    return `domain:${scope.repositoryId ?? ""}:${scope.domainId ?? ""}:${scope.route ?? ""}`;
  }
  return `general:${scope.route ?? ""}`;
}

function validateWorktreeSlotCapacity(repositoryId: string, value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_WORKTREE_SLOTS) {
    throw new Error(
      `Invalid worktree slot capacity for repository ${repositoryId}: ` +
        `${String(value)} (expected an integer from 1 to ${MAX_WORKTREE_SLOTS})`,
    );
  }
  return value;
}

function firstExistingWorkspace(...candidates: Array<string | undefined>): string {
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    try {
      if (lstatSync(candidate).isDirectory()) return candidate;
    } catch {
      // A configured Personal Data or Knowledge path may not exist before import.
    }
  }
  return process.cwd();
}

/**
 * Owns durable Agent session records and the runtime/workspace lifecycle that
 * surrounds them. Turn execution, event fan-out, and interaction responses
 * are intentionally kept in their respective services.
 */
export class AgentSessionService {
  private readonly database: DatabaseClient;
  private readonly host: AgentRuntimeHost;
  private readonly sessionHomeCleaner: AgentSessionHomeCleaner;
  private readonly worktreePool: WorktreePool;
  private readonly agentSessionsPath: string;
  private readonly worktreesPath: string;
  private readonly knowledgePath: string | undefined;
  private readonly personalDataPath: string | undefined;
  private readonly domainWorkspaceRoot: string | undefined;
  private readonly worktreeSlotCapacity: WorktreeSlotCapacityResolver | undefined;
  private readonly defaults: AgentRuntimeDefaults;
  private readonly now: () => Date;
  private readonly sessionCreates = new Map<string, Promise<AgentSessionView>>();
  private readonly titleFlights = new Map<string, Promise<boolean>>();
  private readonly titleRetryAt = new Map<string, number>();
  private closed = false;

  constructor(options: AgentSessionServiceOptions) {
    this.database = options.database;
    this.host = options.host;
    this.sessionHomeCleaner = options.sessionHomeCleaner;
    this.worktreePool = options.worktreePool;
    this.agentSessionsPath = options.agentSessionsPath;
    this.worktreesPath = options.worktreesPath;
    this.knowledgePath = options.knowledgePath;
    this.personalDataPath = options.personalDataPath;
    this.domainWorkspaceRoot = options.domainWorkspaceRoot;
    this.worktreeSlotCapacity = options.worktreeSlotCapacity;
    this.defaults = options.defaults;
    this.now = options.now ?? (() => new Date());
  }

  async ensureSession(body: AgentSessionCreate): Promise<AgentSessionView> {
    const existing = findAgentSession(this.database, body.scope);
    if (existing !== null) {
      touchAgentSession(this.database, existing.id);
      return this.viewFor(existing);
    }
    const key = sessionScopeKey(body.scope);
    const inFlight = this.sessionCreates.get(key);
    if (inFlight !== undefined) return inFlight;
    const creation = this.createSession(body);
    this.sessionCreates.set(key, creation);
    try {
      return await creation;
    } finally {
      if (this.sessionCreates.get(key) === creation) {
        this.sessionCreates.delete(key);
      }
    }
  }

  /** Create one independent durable session for a scheduled occurrence. */
  async ensureScheduledSession(input: {
    taskId: string;
    runId: string;
    workspacePath: string;
    provider: string;
    model: string;
    reasoningEffort: string;
    title?: string;
  }): Promise<AgentSessionSummary> {
    const scope: AgentScope = {
      kind: "general",
      route: `scheduled-task:${input.taskId}:run:${input.runId}`,
    };
    const existing = findAgentSession(this.database, scope);
    if (existing !== null) return existing;
    const id = `sess_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    return createAgentSession(this.database, {
      id,
      scope,
      dshHomePath: join(this.agentSessionsPath, id, "dsh-home"),
      workspacePath: input.workspacePath,
      provider: input.provider,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      title: input.title ?? `Scheduled: ${input.taskId}`,
      titleSource: "provisional",
      now: new Date().toISOString(),
    });
  }

  private async createSession(body: AgentSessionCreate): Promise<AgentSessionView> {
    const id = `sess_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const workspace = await this.prepareWorkspace(body.scope);
    const raced = findAgentSession(this.database, body.scope);
    if (raced !== null) return this.viewFor(raced);
    const session = createAgentSession(this.database, {
      id,
      scope: body.scope,
      dshHomePath: join(this.agentSessionsPath, id, "dsh-home"),
      workspacePath: workspace.path,
      provider: body.provider ?? this.defaults.provider,
      model: body.model ?? this.defaults.model,
      reasoningEffort: body.reasoningEffort ?? this.defaults.reasoningEffort,
      title: body.title ?? null,
      titleSource: body.title === undefined ? "provisional" : "manual",
      now: new Date().toISOString(),
    });
    return this.viewFor(session);
  }

  listSessions(query: AgentSessionsQuery): AgentSessionSummary[] {
    return listAgentSessions(this.database, {
      scopeKind: query.scopeKind,
      repositoryId: query.repositoryId,
      prNumber: query.prNumber,
      issueNumber: query.issueNumber,
      knowledgeDocumentId: query.knowledgeDocumentId,
      status: query.status,
      search: query.search ?? query.q,
      limit: query.limit,
    });
  }

  async deleteSession(sessionId: string): Promise<{ deleted: true }> {
    requireAgentSession(this.database, sessionId);
    const homeCleanup = await this.sessionHomeCleaner.preflight(sessionId);
    await this.host.restart(sessionId);
    deleteAgentSession(this.database, sessionId);
    await homeCleanup.remove();
    this.clearTitleRetryState(sessionId);
    return { deleted: true };
  }

  async updateSession(
    sessionId: string,
    patch: AgentSessionUpdate,
  ): Promise<AgentSessionView> {
    requireAgentSession(this.database, sessionId);
    const updated = updateAgentSession(this.database, sessionId, {
      ...(patch.provider !== undefined ? { provider: patch.provider } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.reasoningEffort !== undefined ? { reasoningEffort: patch.reasoningEffort } : {}),
      ...(patch.title !== undefined ? { title: patch.title } : {}),
    });
    if (patch.title !== undefined && patch.title !== null) {
      const runtime = this.host.runtime(sessionId);
      const runtimeSessionId = runtime?.runtimeSessionId?.(sessionId) ?? null;
      if (runtime !== undefined && runtimeSessionId !== null) {
        try {
          await this.host.rename(sessionId, patch.title);
        } catch {
          // The local manual title remains the source of truth.
        }
      }
    }
    return this.viewFor(updated);
  }

  /** Explicit name for callers that only need the title ownership operation. */
  async renameSession(sessionId: string, title: string): Promise<AgentSessionView> {
    return this.updateSession(sessionId, { title });
  }

  async discoverCapabilities(): Promise<AgentRuntimeCapabilities | null> {
    mkdirSync(this.agentSessionsPath, { recursive: true });
    const probeRoot = mkdtempSync(join(this.agentSessionsPath, "capability-"));
    const spec: AgentSessionSpec = {
      sessionId: `capability_${randomUUID().replace(/-/g, "")}`,
      workspacePath: firstExistingWorkspace(this.personalDataPath, this.knowledgePath),
      dshHomePath: join(probeRoot, "dsh-home"),
      provider: this.defaults.provider,
      model: this.defaults.model,
      reasoningEffort: this.defaults.reasoningEffort,
    };
    mkdirSync(spec.dshHomePath, { recursive: true });
    try {
      return await this.host.discoverCapabilities(spec);
    } finally {
      rmSync(probeRoot, { recursive: true, force: true });
    }
  }

  health(): { status: "ok"; activeSessions: number; idleCloseMs: number } {
    return {
      status: "ok",
      activeSessions: this.host.activeCount(),
      idleCloseMs: this.host.idleCloseWindowMs(),
    };
  }

  updateDefaults(patch: {
    provider?: string;
    model?: string;
    reasoningEffort?: string;
    idleProcessMinutes?: number;
  }): AgentRuntimeDefaults {
    if (patch.provider !== undefined) {
      if (patch.provider.trim().length === 0) throw new Error("provider must not be empty");
      this.defaults.provider = patch.provider;
    }
    if (patch.model !== undefined) {
      if (patch.model.trim().length === 0) throw new Error("model must not be empty");
      this.defaults.model = patch.model;
    }
    if (patch.reasoningEffort !== undefined) {
      if (patch.reasoningEffort.trim().length === 0) {
        throw new Error("reasoningEffort must not be empty");
      }
      this.defaults.reasoningEffort = patch.reasoningEffort;
    }
    if (patch.idleProcessMinutes !== undefined) {
      if (!Number.isInteger(patch.idleProcessMinutes) || patch.idleProcessMinutes < 0) {
        throw new Error("idleProcessMinutes must be a non-negative integer");
      }
      this.defaults.idleProcessMinutes = patch.idleProcessMinutes;
      this.host.updateIdleCloseMs(patch.idleProcessMinutes * 60_000);
    }
    return { ...this.defaults };
  }

  updateRuntimeSettings(patch: {
    defaultProvider?: string | null;
    defaultModel?: string | null;
    defaultReasoning?: string | null;
    retentionMinutes?: number;
  }): void {
    if (patch.defaultProvider !== undefined && patch.defaultProvider !== null) {
      this.defaults.provider = patch.defaultProvider;
    }
    if (patch.defaultModel !== undefined && patch.defaultModel !== null) {
      this.defaults.model = patch.defaultModel;
    }
    if (patch.defaultReasoning !== undefined && patch.defaultReasoning !== null) {
      this.defaults.reasoningEffort = patch.defaultReasoning;
    }
    if (patch.retentionMinutes !== undefined) {
      if (!Number.isInteger(patch.retentionMinutes) || patch.retentionMinutes < 0) {
        throw new Error("retentionMinutes must be a non-negative integer");
      }
      this.defaults.idleProcessMinutes = patch.retentionMinutes;
      this.host.updateIdleCloseMs(patch.retentionMinutes * 60_000);
    }
  }

  listMessages(sessionId: string): { items: ReturnType<typeof listAgentMessages> } {
    requireAgentSession(this.database, sessionId);
    return { items: listAgentMessages(this.database, sessionId) };
  }

  async view(sessionId: string): Promise<AgentSessionView> {
    return this.viewFor(requireAgentSession(this.database, sessionId));
  }

  async syncWorkspace(sessionId: string): Promise<AgentSessionView> {
    const session = requireAgentSession(this.database, sessionId);
    if (session.scope.kind !== "pr") return this.viewFor(session);
    await this.host.restart(sessionId);
    const workspace = await this.prepareWorkspace(session.scope);
    const updated =
      workspace.path === session.workspacePath
        ? session
        : updateAgentSession(this.database, sessionId, {
            workspacePath: workspace.path,
          });
    await this.requireRevisionMatch(updated);
    return this.viewFor(updated);
  }

  require(sessionId: string): AgentSessionSummary {
    return requireAgentSession(this.database, sessionId);
  }

  async readWorkspaceRevision(path: string): Promise<string | null> {
    try {
      return await this.worktreePool.revision(path);
    } catch {
      return null;
    }
  }

  async requireRevisionMatch(session: AgentSessionSummary): Promise<void> {
    if (session.scope.kind !== "pr") return;
    const targetSha = session.scope.targetSha ?? null;
    const actualSha = await this.readWorkspaceRevision(session.workspacePath);
    if (targetSha === null || actualSha === null || actualSha !== targetSha) {
      throw new WorkspaceRevisionMismatchError(
        session.workspacePath,
        targetSha,
        actualSha,
      );
    }
  }

  /**
   * Try one native title projection after a successful turn. The result is
   * true only when the provisional row was atomically promoted, so the turn
   * service can emit the same idle refresh event used by the existing UI.
   */
  async discoverNativeTitle(sessionId: string): Promise<boolean> {
    if (this.closed) return false;
    const existingFlight = this.titleFlights.get(sessionId);
    if (existingFlight !== undefined) return existingFlight;
    const session = this.readProvisionalSession(sessionId);
    if (session === null) return false;
    const retryAt = this.titleRetryAt.get(sessionId);
    if (retryAt !== undefined && this.nowMs() < retryAt) return false;
    const flight = this.lookupNativeTitle(sessionId);
    this.titleFlights.set(sessionId, flight);
    try {
      return await flight;
    } finally {
      if (this.titleFlights.get(sessionId) === flight) {
        this.titleFlights.delete(sessionId);
      }
    }
  }

  clearTitleRetryState(sessionId: string): void {
    this.titleFlights.delete(sessionId);
    this.titleRetryAt.delete(sessionId);
  }

  /** Runtime lifecycle surface consumed by AgentTurnService. */
  ensureRuntime(spec: AgentSessionSpec): AgentRuntime {
    return this.host.ensure(spec);
  }

  beginRuntimeRun(sessionId: string): void {
    this.host.beginRun(sessionId);
  }

  endRuntimeRun(sessionId: string): void {
    this.host.endRun(sessionId);
  }

  isRuntimeRunning(sessionId: string): boolean {
    return this.host.isRunning(sessionId);
  }

  runtime(sessionId: string): AgentRuntime | undefined {
    return this.host.runtime(sessionId);
  }

  runtimeSessionId(runtime: AgentRuntime, sessionId: string): string | null {
    return runtime.runtimeSessionId?.(sessionId) ?? null;
  }

  updateRuntimeState(
    sessionId: string,
    patch: Parameters<typeof updateAgentSession>[2],
  ): AgentSessionSummary {
    return updateAgentSession(this.database, sessionId, patch);
  }

  async restartRuntime(sessionId: string): Promise<void> {
    await this.host.restart(sessionId);
  }

  async respondRuntime(
    runtime: AgentRuntime,
    sessionId: string,
    requestId: string,
    value: string,
  ): Promise<void> {
    if (runtime.respond === undefined) {
      throw new Error(`Runtime session ${sessionId} does not support responses`);
    }
    await runtime.respond(sessionId, requestId, value);
  }

  async closeRuntime(): Promise<void> {
    this.closed = true;
    await this.host.close();
    this.titleFlights.clear();
    this.titleRetryAt.clear();
    this.sessionCreates.clear();
  }

  private readProvisionalSession(sessionId: string): AgentSessionSummary | null {
    try {
      const session = requireAgentSession(this.database, sessionId);
      return session.titleSource === "provisional" ? session : null;
    } catch {
      return null;
    }
  }

  private async lookupNativeTitle(sessionId: string): Promise<boolean> {
    const retry = () => {
      if (this.readProvisionalSession(sessionId) !== null) {
        this.titleRetryAt.set(sessionId, this.nowMs() + AGENT_TITLE_RETRY_COOLDOWN_MS);
      }
    };
    try {
      const session = this.readProvisionalSession(sessionId);
      if (session === null || this.closed) return false;
      const runtime = this.host.runtime(sessionId);
      const runtimeSessionId = runtime?.runtimeSessionId?.(sessionId) ?? null;
      if (runtime === undefined || runtimeSessionId === null || runtime.getTitle === undefined) {
        retry();
        return false;
      }
      const nativeTitle = await this.host.getTitle(sessionId);
      if (this.closed || nativeTitle === null || nativeTitle.title.trim().length === 0) {
        if (!this.closed) retry();
        return false;
      }
      const result = setGeneratedAgentSessionTitleIfProvisional(
        this.database,
        sessionId,
        nativeTitle.title,
      );
      if (result.updated) {
        this.titleRetryAt.delete(sessionId);
        return true;
      }
      // A manual rename won the conditional update; it permanently owns title.
      this.titleRetryAt.delete(sessionId);
      return false;
    } catch {
      retry();
      return false;
    }
  }

  private nowMs(): number {
    const value = this.now().getTime();
    return Number.isFinite(value) ? value : Date.now();
  }

  private async viewFor(session: AgentSessionSummary): Promise<AgentSessionView> {
    return {
      session,
      targetRevision:
        session.scope.kind === "pr" ? (session.scope.targetSha ?? null) : null,
      workspaceRevision: await this.readWorkspaceRevision(session.workspacePath),
    };
  }

  private async prepareWorkspace(scope: AgentScope): Promise<{ path: string }> {
    if (scope.kind === "pr") {
      const repository = requireEnabledRepository(this.database, scope.repositoryId ?? "");
      const targetSha = scope.targetSha;
      if (targetSha === undefined) throw new Error("PR agent scope is missing targetSha");
      const prNumber = scope.prNumber;
      if (prNumber === undefined) throw new Error("PR agent scope is missing prNumber");
      const fallbackSlots = repository.worktreeSlots;
      const configuredSlots = validateWorktreeSlotCapacity(
        repository.id,
        await (this.worktreeSlotCapacity?.(repository.id, fallbackSlots) ?? fallbackSlots),
      );
      const busySlotPaths = listBusyWorkspacePaths(this.database, repository.id);
      const slotRows = listWorktreeSlots(this.database, repository.id);
      const slot: AllocatedSlot = await this.worktreePool.allocate({
        mainRepositoryPath: repository.localPath,
        poolRoot: join(this.worktreesPath, repository.key),
        slotCount: configuredSlots,
        prNumber,
        targetSha,
        busySlotPaths,
        slots: slotRows.map((row) => ({
          slotName: row.slotName,
          slotPath: row.path,
          prNumber: row.prNumber,
          targetSha: row.targetSha,
          lastUsedAt: row.lastUsedAt,
        })),
        onUsed: (usage) => {
          recordWorktreeSlotUse(this.database, {
            repositoryId: repository.id,
            slotName: usage.slotName,
            path: usage.slotPath,
            prNumber: usage.prNumber,
            targetSha: usage.targetSha,
            lastUsedAt: usage.lastUsedAt,
          });
        },
      });
      return { path: slot.slotPath };
    }
    if (scope.repositoryId !== undefined) {
      if (scope.kind === "domain") {
        requireEnabledRepository(this.database, scope.repositoryId);
        return {
          path: firstExistingWorkspace(this.domainWorkspaceRoot, this.knowledgePath),
        };
      }
      const repository = requireEnabledRepository(this.database, scope.repositoryId);
      return { path: repository.localPath };
    }
    return { path: firstExistingWorkspace(this.personalDataPath, this.knowledgePath) };
  }
}

/**
 * A PR chat cannot run because its worktree is not on the target revision.
 * The server never syncs automatically; the UI offers an explicit sync.
 */
export class WorkspaceRevisionMismatchError extends Error {
  readonly code = "WORKSPACE_REVISION_MISMATCH" as const;

  constructor(workspacePath: string, targetSha: string | null, actualSha: string | null) {
    super(
      `PR workspace ${workspacePath} is on ${
        actualSha === null ? "an unknown revision" : actualSha
      } but the session targets ${
        targetSha === null ? "an unknown revision" : targetSha
      }. Sync the workspace before continuing this chat.`,
    );
    this.name = "WorkspaceRevisionMismatchError";
  }
}
