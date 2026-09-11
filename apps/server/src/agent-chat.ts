import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  AgentRuntimeHost,
  type AgentRuntime,
  type AgentRuntimeEvent,
  type AgentSessionSpec,
} from "@loongboard/agent-runtime";
import { DSHRuntime } from "@loongboard/agent-runtime-dsh";
import {
  appendAgentMessage,
  createAgentSession,
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
  deleteAgentSession,
  updateAgentMessage,
  updateAgentSession,
  type DatabaseClient,
} from "@loongboard/database";
import {
  agentMessageAcceptedSchema,
  agentMessageCreateSchema,
  agentMessagesResponseSchema,
  agentInteractionParamsSchema,
  agentInteractionResponseSchema,
  agentParamsSchema,
  agentRuntimeEventSchema,
  agentSessionCreateSchema,
  agentSessionDeleteResponseSchema,
  agentSessionResponseSchema,
  agentSessionUpdateSchema,
  agentSessionsQuerySchema,
  agentSessionsResponseSchema,
  type AgentMessageAccepted,
  type AgentRuntimeEvent as ContractEvent,
  type AgentRuntimeCapabilities,
  type AgentScope,
  type AgentSessionCreate,
  type AgentSessionUpdate,
  type AgentSessionSummary,
  type AgentSessionsQuery,
} from "@loongboard/contracts";
import { WorktreePool, type AllocatedSlot } from "@loongboard/git-workspace";
import type { FastifyInstance, FastifyReply } from "fastify";

import { InvalidRequestError, parseRequest, sendParsed } from "./route-helpers.js";
import { AgentSessionHomeCleaner } from "./agent-session-home.js";
import { WorkspaceRunCoordinator } from "./workspace-run-coordinator.js";

export class AgentSessionNotFoundError extends Error {
  readonly code = "AGENT_SESSION_NOT_FOUND" as const;

  constructor(sessionId: string) {
    super(`Agent session ${sessionId} was not found`);
    this.name = "AgentSessionNotFoundError";
  }
}

export class AgentTurnBusyError extends Error {
  readonly code = "AGENT_TURN_BUSY" as const;

  constructor(sessionId: string) {
    super(`Agent session ${sessionId} already has a running turn`);
    this.name = "AgentTurnBusyError";
  }
}

export class AgentInteractionUnavailableError extends Error {
  readonly code = "AGENT_INTERACTION_UNAVAILABLE" as const;

  constructor(sessionId: string, reason = "the session has no active interaction") {
    super(`Agent session ${sessionId} cannot resolve an interaction: ${reason}`);
    this.name = "AgentInteractionUnavailableError";
  }
}

/** The workspace is claimed by another agent turn (Chat or scheduler). */
export class WorkspaceRunBusyError extends Error {
  readonly code = "WORKSPACE_BUSY" as const;

  constructor(workspacePath: string) {
    super(`Another agent turn is already using the workspace: ${workspacePath}`);
    this.name = "WorkspaceRunBusyError";
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

function interactionKey(sessionId: string, requestId: string): string {
  return `${sessionId}\u0000${requestId}`;
}

export const MAX_WORKTREE_SLOTS = 8;

export type WorktreeSlotCapacityResolver = (
  repositoryId: string,
  configuredSlots: number,
) => number | Promise<number>;

function validateWorktreeSlotCapacity(repositoryId: string, value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_WORKTREE_SLOTS) {
    throw new Error(
      `Invalid worktree slot capacity for repository ${repositoryId}: ` +
        `${String(value)} (expected an integer from 1 to ${MAX_WORKTREE_SLOTS})`,
    );
  }
  return value;
}

export interface AgentChatDependencies {
  database: DatabaseClient;
  /** Shared in-process ownership guard for every agent workspace. */
  workspaceRuns: WorkspaceRunCoordinator;
  /** Root that holds per-session DSH homes (system/.loong/agent-sessions). */
  agentSessionsPath: string;
  /** Root that holds per-repository worktree pools (system/.worktrees). */
  worktreesPath: string;
  /** Knowledge root used as the cwd for knowledge/general chats. */
  knowledgePath?: string;
  /** System root used by Domain conversations to edit JSON/prompt files. */
  domainWorkspaceRoot?: string;
  /** Optional pool override (tests inject a gated/fake pool). */
  worktreePool?: WorktreePool;
  /** Runtime Settings authority; the DB/system value is only the fallback. */
  worktreeSlotCapacity?: WorktreeSlotCapacityResolver;
  defaults: {
    provider: string;
    model: string;
    reasoningEffort: string;
    idleProcessMinutes: number;
  };
  /** Optional runtime factory override (tests inject a scripted runtime). */
  runtimeFactory?: (spec: AgentSessionSpec) => AgentRuntime;
  /** Provider secrets delivered to the DSH native credential boundary. */
  credentials?: () => Promise<Record<string, string>>;
}

/** One session view plus its PR revision snapshot (plan 12.5, 17.5). */
export interface AgentSessionView {
  session: AgentSessionSummary;
  targetRevision: string | null;
  workspaceRevision: string | null;
}

interface SseConnection {
  reply: FastifyReply;
  closed: boolean;
}

function defaultRuntimeFactory(
  credentials?: () => Promise<Record<string, string>>,
): (spec: AgentSessionSpec) => AgentRuntime {
  // The DSH web host owns permission presets and approval handling. The child
  // inherits the parent environment only so runtime credentials can reach
  // DSH's own provider settings; GitHub credentials are removed below.
  return () => {
    // GitHub credentials are injected by the GitHub integration at the
    // boundary that needs them. They must never be inherited by an arbitrary
    // runtime child through the ambient process environment.
    const { GH_TOKEN: _ghToken, GITHUB_TOKEN: _githubToken, ...parentEnv } = process.env;
    void _ghToken;
    void _githubToken;
    return new DSHRuntime({
      env: parentEnv,
      ...(credentials === undefined ? {} : { credentials }),
    });
  };
}

/**
 * Session-scoped chat controller (plan 13, 14, 17.5): finds or creates the
 * default session for a scope, allocates disposable worktrees for PR chats,
 * runs turns through the AgentRuntimeHost while fanning normalized events out
 * to SSE subscribers, persists only LoongBoard-normalized messages, and never
 * injects page context into prompts (plan 13.6).
 */
export class AgentChatController {
  private readonly host: AgentRuntimeHost;
  private readonly sessionHomeCleaner: AgentSessionHomeCleaner;
  private readonly subscribers = new Map<string, Set<SseConnection>>();
  private readonly runningTurns = new Map<string, Promise<void>>();
  private readonly cancelled = new Set<string>();
  private readonly emittedInteractionResolutions = new Set<string>();
  /** Prevent a native title lookup from being retried after its first attempt. */
  private readonly titleAttempts = new Set<string>();
  private readonly sessionCreates = new Map<string, Promise<AgentSessionView>>();
  private readonly worktreePool: WorktreePool;

  constructor(private readonly dependencies: AgentChatDependencies) {
    const idleMs = dependencies.defaults.idleProcessMinutes * 60_000;
    this.host = new AgentRuntimeHost(
      dependencies.runtimeFactory ?? defaultRuntimeFactory(dependencies.credentials),
      idleMs,
    );
    this.sessionHomeCleaner = new AgentSessionHomeCleaner(dependencies.agentSessionsPath);
    this.worktreePool = dependencies.worktreePool ?? new WorktreePool();
  }

  async ensureSession(body: AgentSessionCreate): Promise<AgentSessionView> {
    const { database } = this.dependencies;
    const scope = body.origin ?? body.scope;
    const normalizedBody: AgentSessionCreate = { ...body, scope };
    const existing = findAgentSession(database, scope);
    if (existing !== null) {
      touchAgentSession(database, existing.id);
      return this.viewFor(existing);
    }
    // Single-flight per scope: two StrictMode/concurrent opens must share one
    // allocation and one persisted session instead of racing the first
    // worktree checkout.
    const key = sessionScopeKey(scope);
    const inFlight = this.sessionCreates.get(key);
    if (inFlight !== undefined) return inFlight;
    const creation = this.createSession(normalizedBody);
    this.sessionCreates.set(key, creation);
    try {
      return await creation;
    } finally {
      if (this.sessionCreates.get(key) === creation) {
        this.sessionCreates.delete(key);
      }
    }
  }

  /**
   * Create the durable conversation for one scheduled occurrence. The run id
   * is part of the scope so every occurrence gets an independent transcript;
   * scheduler input is trusted local state and never accepts a browser
   * supplied workspace.
   */
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
    const existing = findAgentSession(this.dependencies.database, scope);
    if (existing !== null) {
      return existing;
    }
    const id = `sess_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const session = createAgentSession(this.dependencies.database, {
      id,
      scope,
      dshHomePath: join(this.dependencies.agentSessionsPath, id, "dsh-home"),
      workspacePath: input.workspacePath,
      provider: input.provider,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      title: input.title ?? `Scheduled: ${input.taskId}`,
      titleSource: "provisional",
      now: new Date().toISOString(),
    });
    return session;
  }

  private async createSession(body: AgentSessionCreate): Promise<AgentSessionView> {
    const { database } = this.dependencies;
    const id = `sess_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const workspace = await this.prepareWorkspace(id, body.scope);
    // Re-check after the (potentially slow) allocation so a session created
    // by an earlier caller wins over a duplicate in-flight request.
    const raced = findAgentSession(database, body.scope);
    if (raced !== null) return this.viewFor(raced);
    const session = createAgentSession(database, {
      id,
      scope: body.scope,
      dshHomePath: join(this.dependencies.agentSessionsPath, id, "dsh-home"),
      workspacePath: workspace.path,
      provider: body.provider ?? this.dependencies.defaults.provider,
      model: body.model ?? this.dependencies.defaults.model,
      reasoningEffort: body.reasoningEffort ?? this.dependencies.defaults.reasoningEffort,
      title: body.title ?? null,
      titleSource: body.title === undefined ? "provisional" : "manual",
      now: new Date().toISOString(),
    });
    return this.viewFor(session);
  }

  /** Sessions matching an optional scope filter, newest activity first. */
  listSessions(query: AgentSessionsQuery): AgentSessionSummary[] {
    return listAgentSessions(this.dependencies.database, {
      scopeType: query.scopeType,
      originKind: query.originKind,
      repositoryId: query.repositoryId,
      prNumber: query.prNumber,
      issueNumber: query.issueNumber,
      knowledgeDocumentId: query.knowledgeDocumentId,
      status: query.status,
      search: query.search ?? query.q,
      limit: query.limit,
    });
  }

  /** Stop and delete one normalized conversation and its transcript. */
  async deleteSession(sessionId: string): Promise<{ deleted: true }> {
    if (this.runningTurns.has(sessionId)) {
      throw new AgentTurnBusyError(sessionId);
    }
    requireAgentSession(this.dependencies.database, sessionId);
    const homeCleanup = await this.sessionHomeCleaner.preflight(sessionId);
    await this.host.restart(sessionId);
    deleteAgentSession(this.dependencies.database, sessionId);
    await homeCleanup.remove();
    this.titleAttempts.delete(sessionId);
    this.clearInteractionResolutions(sessionId);
    const subscribers = this.subscribers.get(sessionId);
    if (subscribers !== undefined) {
      for (const connection of subscribers) {
        connection.closed = true;
        try {
          connection.reply.raw.end();
        } catch {
          // The socket may already be gone.
        }
      }
      this.subscribers.delete(sessionId);
    }
    return { deleted: true };
  }

  /** Apply route settings for the next turn while preserving the conversation. */
  async updateSession(
    sessionId: string,
    patch: AgentSessionUpdate,
  ): Promise<AgentSessionView> {
    if (this.runningTurns.has(sessionId)) {
      throw new AgentTurnBusyError(sessionId);
    }
    requireAgentSession(this.dependencies.database, sessionId);
    const updated = updateAgentSession(this.dependencies.database, sessionId, {
      ...(patch.provider !== undefined ? { provider: patch.provider } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.reasoningEffort !== undefined ? { reasoningEffort: patch.reasoningEffort } : {}),
      ...(patch.title !== undefined ? { title: patch.title } : {}),
    });
    if (patch.title !== undefined && patch.title !== null) {
      // Local manual ownership is authoritative. Keep an already-live native
      // session in sync when it has an opaque runtime id, but never make a
      // DSH rename failure turn a successful local rename into an HTTP error.
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

  /** Probe runtime capabilities from the trusted server workspace. */
  async discoverCapabilities(): Promise<AgentRuntimeCapabilities | null> {
    mkdirSync(this.dependencies.agentSessionsPath, { recursive: true });
    const probeRoot = mkdtempSync(join(this.dependencies.agentSessionsPath, "capability-"));
    const spec: AgentSessionSpec = {
      sessionId: `capability_${randomUUID().replace(/-/g, "")}`,
      workspacePath: this.dependencies.knowledgePath ?? process.cwd(),
      dshHomePath: join(probeRoot, "dsh-home"),
      provider: this.dependencies.defaults.provider,
      model: this.dependencies.defaults.model,
      reasoningEffort: this.dependencies.defaults.reasoningEffort,
    };
    mkdirSync(spec.dshHomePath, { recursive: true });
    try {
      return await this.host.discoverCapabilities(spec);
    } finally {
      rmSync(probeRoot, { recursive: true, force: true });
    }
  }

  health(): {
    status: "ok";
    activeSessions: number;
    idleCloseMs: number;
  } {
    return {
      status: "ok",
      activeSessions: this.host.activeCount(),
      idleCloseMs: this.host.idleCloseWindowMs(),
    };
  }

  /**
   * Change runtime defaults for newly created sessions. Existing sessions
   * keep their route; changing idle retention only rearms idle runtimes.
   */
  updateDefaults(patch: {
    provider?: string;
    model?: string;
    reasoningEffort?: string;
    idleProcessMinutes?: number;
  }): {
    provider: string;
    model: string;
    reasoningEffort: string;
    idleProcessMinutes: number;
  } {
    if (patch.provider !== undefined) {
      if (patch.provider.trim().length === 0) throw new Error("provider must not be empty");
      this.dependencies.defaults.provider = patch.provider;
    }
    if (patch.model !== undefined) {
      if (patch.model.trim().length === 0) throw new Error("model must not be empty");
      this.dependencies.defaults.model = patch.model;
    }
    if (patch.reasoningEffort !== undefined) {
      if (patch.reasoningEffort.trim().length === 0) {
        throw new Error("reasoningEffort must not be empty");
      }
      this.dependencies.defaults.reasoningEffort = patch.reasoningEffort;
    }
    if (patch.idleProcessMinutes !== undefined) {
      if (!Number.isInteger(patch.idleProcessMinutes) || patch.idleProcessMinutes < 0) {
        throw new Error("idleProcessMinutes must be a non-negative integer");
      }
      this.dependencies.defaults.idleProcessMinutes = patch.idleProcessMinutes;
      this.host.updateIdleCloseMs(patch.idleProcessMinutes * 60_000);
    }
    return {
      provider: this.dependencies.defaults.provider,
      model: this.dependencies.defaults.model,
      reasoningEffort: this.dependencies.defaults.reasoningEffort,
      idleProcessMinutes: this.dependencies.defaults.idleProcessMinutes,
    };
  }

  /** Apply control-center runtime defaults without exposing DSH internals. */
  updateRuntimeSettings(patch: {
    defaultProvider?: string | null;
    defaultModel?: string | null;
    defaultReasoning?: string | null;
    retentionMinutes?: number;
  }): void {
    if (patch.defaultProvider !== undefined && patch.defaultProvider !== null) {
      this.dependencies.defaults.provider = patch.defaultProvider;
    }
    if (patch.defaultModel !== undefined && patch.defaultModel !== null) {
      this.dependencies.defaults.model = patch.defaultModel;
    }
    if (patch.defaultReasoning !== undefined && patch.defaultReasoning !== null) {
      this.dependencies.defaults.reasoningEffort = patch.defaultReasoning;
    }
    if (patch.retentionMinutes !== undefined) {
      if (!Number.isInteger(patch.retentionMinutes) || patch.retentionMinutes < 0) {
        throw new Error("retentionMinutes must be a non-negative integer");
      }
      this.dependencies.defaults.idleProcessMinutes = patch.retentionMinutes;
      this.host.updateIdleCloseMs(patch.retentionMinutes * 60_000);
    }
  }

  listMessages(sessionId: string): { items: ReturnType<typeof listAgentMessages> } {
    requireAgentSession(this.dependencies.database, sessionId);
    return { items: listAgentMessages(this.dependencies.database, sessionId) };
  }

  /** One session plus revision snapshot (plan 12.5). */
  async view(sessionId: string): Promise<AgentSessionView> {
    const session = requireAgentSession(this.dependencies.database, sessionId);
    return this.viewFor(session);
  }

  /**
   * Point the PR session's worktree back at its target revision (plan 12.5
   * "同步工作区"). Non-PR scopes are already stable and return unchanged.
   */
  async syncWorkspace(sessionId: string): Promise<AgentSessionView> {
    const session = requireAgentSession(this.dependencies.database, sessionId);
    if (this.runningTurns.has(sessionId)) {
      throw new AgentTurnBusyError(sessionId);
    }
    if (session.scope.kind !== "pr") return this.viewFor(session);
    // The DSH process pins its cwd when it starts; restart the host boundary
    // before the worktree is switched so its internal id cannot bind the next
    // turn to a stale process or workspace.
    await this.host.restart(sessionId);
    const workspace = await this.prepareWorkspace(sessionId, session.scope);
    const updated =
      workspace.path === session.workspacePath
        ? session
        : updateAgentSession(this.dependencies.database, sessionId, {
            workspacePath: workspace.path,
          });
    await this.requireRevisionMatch(updated);
    return this.viewFor(updated);
  }

  /** Public existence check used by routes before opening an SSE stream. */
  require(sessionId: string): AgentSessionSummary {
    return requireAgentSession(this.dependencies.database, sessionId);
  }

  /** Accept a user message and start the turn in the background. */
  async acceptMessage(
    sessionId: string,
    content: string,
  ): Promise<AgentMessageAccepted> {
    if (this.runningTurns.has(sessionId)) {
      throw new AgentTurnBusyError(sessionId);
    }
    const session = requireAgentSession(this.dependencies.database, sessionId);
    await this.requireRevisionMatch(session);
    const release = this.acquireWorkspace(session);
    try {
      const userMessage = appendAgentMessage(this.dependencies.database, {
        sessionId,
        role: "user",
        contentMarkdown: content,
      });
      const turn = this.runTurn(session, content);
      this.runningTurns.set(sessionId, turn);
      void turn.finally(() => {
        this.runningTurns.delete(sessionId);
        this.cancelled.delete(sessionId);
        release();
      });
      return { messageId: userMessage.id, status: "accepted" };
    } catch (error) {
      release();
      throw error;
    }
  }

  /**
   * Run (and await) one full turn on an existing session without appending a
   * user row — used by the scheduler, which persists the prompt itself so the
   * scheduled text is sent verbatim (plan 16.1). When the scheduler already
   * owns the workspace, pass `workspaceOwned: true` so the run entry does not
   * acquire the shared coordinator a second time.
   */
  async runSessionTurn(
    sessionId: string,
    prompt: string,
    options: { workspaceOwned?: boolean } = {},
  ): Promise<AgentSessionSummary> {
    if (this.runningTurns.has(sessionId)) {
      throw new AgentTurnBusyError(sessionId);
    }
    const session = requireAgentSession(this.dependencies.database, sessionId);
    await this.requireRevisionMatch(session);
    const release =
      options.workspaceOwned === true
        ? null
        : this.acquireWorkspace(session);
    try {
      const turn = this.runTurn(session, prompt);
      this.runningTurns.set(sessionId, turn);
      try {
        await turn;
      } finally {
        this.runningTurns.delete(sessionId);
        this.cancelled.delete(sessionId);
      }
    } finally {
      release?.();
    }
    return requireAgentSession(this.dependencies.database, sessionId);
  }

  /** Register an SSE subscriber; returns an unsubscribe function. */
  subscribe(sessionId: string, reply: FastifyReply): () => void {
    const connection: SseConnection = { reply, closed: false };
    const set = this.subscribers.get(sessionId) ?? new Set<SseConnection>();
    set.add(connection);
    this.subscribers.set(sessionId, set);
    return () => {
      connection.closed = true;
      set.delete(connection);
      if (set.size === 0) this.subscribers.delete(sessionId);
    };
  }

  /**
   * Cancel one session by terminating its process (plan 13.4). When a turn is
   * running the turn is interrupted; an idle session is simply marked
   * interrupted so the caller can retry with a fresh message.
   */
  async cancel(sessionId: string): Promise<AgentSessionView> {
    requireAgentSession(this.dependencies.database, sessionId);
    const running = this.runningTurns.has(sessionId);
    if (running) this.cancelled.add(sessionId);
    // A user cancellation invalidates the in-flight DSH session. Restart the
    // host boundary so an adapter's private id cache cannot revive it after
    // the database clears the persisted opaque id.
    await this.host.restart(sessionId);
    updateAgentSession(this.dependencies.database, sessionId, {
      status: "interrupted",
      // The DSH process was killed mid-turn; its durable session log has an
      // open turn, so the persisted runtime session id is stale for the next
      // turn. The next run mints a fresh DSH session instead.
      ...(running ? { dshSessionId: null } : {}),
    });
    this.broadcast(sessionId, { type: "status", status: "stopped" });
    return this.viewFor(requireAgentSession(this.dependencies.database, sessionId));
  }

  /** Resolve a runtime-owned interaction without bypassing the runtime. */
  async respond(sessionId: string, requestId: string, value: string): Promise<void> {
    if (requestId.trim().length === 0) {
      throw new InvalidRequestError("Interaction requestId must not be empty");
    }
    if (value.trim().length === 0) {
      throw new InvalidRequestError("Interaction value must not be empty");
    }
    requireAgentSession(this.dependencies.database, sessionId);
    if (!this.runningTurns.has(sessionId) || !this.host.isRunning(sessionId)) {
      throw new AgentInteractionUnavailableError(sessionId);
    }
    const runtime = this.host.runtime(sessionId);
    if (runtime?.respond === undefined) {
      throw new AgentInteractionUnavailableError(
        sessionId,
        "the connected runtime does not support responses",
      );
    }
    const resolutionKey = interactionKey(sessionId, requestId);
    this.emittedInteractionResolutions.add(resolutionKey);
    try {
      await runtime.respond(sessionId, requestId, value);
    } catch (error) {
      this.emittedInteractionResolutions.delete(resolutionKey);
      throw error;
    }
    const resolved: ContractEvent = {
      type: "interaction.resolved",
      requestId,
    };
    this.persistRuntimeEvent(sessionId, resolved, new Map());
    this.broadcast(sessionId, resolved);
  }

  isRunning(sessionId: string): boolean {
    return this.runningTurns.has(sessionId);
  }

  async close(): Promise<void> {
    const pendingTurns = [...this.runningTurns.values()];
    await this.host.close();
    await Promise.allSettled(pendingTurns);
    for (const set of this.subscribers.values()) {
      for (const connection of set) {
        connection.closed = true;
        try {
          connection.reply.raw.end();
        } catch {
          // The socket may already be gone during shutdown.
        }
      }
    }
    this.subscribers.clear();
    this.cancelled.clear();
    this.emittedInteractionResolutions.clear();
    this.titleAttempts.clear();
    this.runningTurns.clear();
  }

  private async viewFor(session: AgentSessionSummary): Promise<AgentSessionView> {
    return {
      session,
      targetRevision:
        session.scope.kind === "pr" ? (session.scope.targetSha ?? null) : null,
      workspaceRevision: await this.readWorkspaceRevision(session.workspacePath),
    };
  }

  private async readWorkspaceRevision(path: string): Promise<string | null> {
    try {
      return await this.worktreePool.revision(path);
    } catch {
      return null;
    }
  }

  private acquireWorkspace(session: AgentSessionSummary): () => void {
    const release = this.dependencies.workspaceRuns.acquire(session.workspacePath);
    if (release === null) {
      throw new WorkspaceRunBusyError(session.workspacePath);
    }
    return release;
  }

  /**
   * Reject a PR turn whose worktree is not on the session's target revision
   * (plan P0 #4). The server never syncs automatically.
   */
  private async requireRevisionMatch(session: AgentSessionSummary): Promise<void> {
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

  private async runTurn(session: AgentSessionSummary, prompt: string): Promise<void> {
    // A user- or startup-interrupted session may hold an opaque id for a turn
    // whose durable log was cut mid-flight. Clear that id before retrying. A
    // native runtime error has already ended its turn at the DSH boundary, so
    // preserve its id and let the next turn recover the durable conversation.
    const resumeRuntimeSessionId =
      session.status === "interrupted" ? undefined : (session.dshSessionId ?? undefined);
    if (session.status === "interrupted" && session.dshSessionId !== null) {
      updateAgentSession(this.dependencies.database, session.id, {
        dshSessionId: null,
      });
    }
    const spec: AgentSessionSpec = {
      sessionId: session.id,
      workspacePath: session.workspacePath,
      provider: session.provider,
      model: session.model,
      reasoningEffort: session.reasoningEffort,
      dshHomePath: session.dshHomePath,
      runtimeSessionId: resumeRuntimeSessionId,
    };
    // Both interactive and scheduled callers persist the user row before
    // entering this method. A title is eligible only for that first row.
    const isFirstUserTurn =
      listAgentMessages(this.dependencies.database, session.id).filter(
        (message) => message.role === "user",
      ).length === 1;
    mkdirSync(session.dshHomePath, { recursive: true });
    updateAgentSession(this.dependencies.database, session.id, { status: "running" });
    this.host.beginRun(session.id);
    let receivedCompletion = false;
    let receivedAssistantResult = false;
    let terminalIdle = false;
    let runtimeFailed = false;
    let persistedRuntimeSessionId = resumeRuntimeSessionId ?? null;
    const toolMessageIds = new Map<string, string>();
    try {
      const runtime = this.host.ensure(spec);
      this.broadcast(session.id, { type: "status", status: "starting" });
      for await (const event of runtime.run(spec, prompt)) {
        if (this.cancelled.has(session.id)) break;
        const normalized = agentRuntimeEventSchema.parse(event);
        const tracked = runtime as AgentRuntime & {
          runtimeSessionId?: (sessionId: string) => string | null;
        };
        const runtimeSessionId =
          typeof tracked.runtimeSessionId === "function"
            ? tracked.runtimeSessionId(session.id)
            : null;
        if (
          runtimeSessionId !== null &&
          runtimeSessionId !== persistedRuntimeSessionId
        ) {
          updateAgentSession(this.dependencies.database, session.id, {
            dshSessionId: runtimeSessionId,
          });
          persistedRuntimeSessionId = runtimeSessionId;
        }
        if (
          normalized.type === "interaction.resolved" &&
          this.emittedInteractionResolutions.delete(
            interactionKey(session.id, normalized.requestId),
          )
        ) {
          // respond() already persisted and broadcast this acknowledgement;
          // some runtimes also echo a host cancellation frame, so suppress
          // that duplicate while preserving externally originated events.
          continue;
        }
        this.persistRuntimeEvent(session.id, normalized, toolMessageIds);
        if (normalized.type === "assistant.completed") {
          receivedCompletion = true;
          if (normalized.markdown.trim().length > 0) {
            receivedAssistantResult = true;
          }
        }
        if (normalized.type === "status" && normalized.status === "idle") {
          terminalIdle = true;
        }
        if (normalized.type === "error") runtimeFailed = true;
        this.broadcast(session.id, normalized);
      }
    } catch (error) {
      runtimeFailed = true;
      const message = error instanceof Error ? error.message : String(error);
      this.broadcast(session.id, { type: "error", message });
      appendAgentMessage(this.dependencies.database, {
        sessionId: session.id,
        role: "system-status",
        contentMarkdown: message,
      });
    } finally {
      const interrupted = this.cancelled.has(session.id);
      const completed = (terminalIdle || receivedCompletion) && !runtimeFailed;
      this.host.endRun(session.id);
      const nextStatus = interrupted ? "interrupted" : completed ? "idle" : "error";
      updateAgentSession(this.dependencies.database, session.id, {
        status: nextStatus,
        // Cancellation cuts an in-flight turn and invalidates its opaque id.
        // A native error still has a durable DSH conversation, so retain the
        // id for recovery on the next turn.
        ...(nextStatus === "interrupted" ? { dshSessionId: null } : {}),
      });
      this.broadcast(session.id, { type: "status", status: "idle" });
      this.clearInteractionResolutions(session.id);
      if (!interrupted && completed && receivedAssistantResult) {
        // The answer and terminal status are already delivered. Native title
        // discovery stays secondary and must never extend the user's turn.
        void this.discoverGeneratedTitle(session.id, isFirstUserTurn);
      }
    }
  }

  /** Best-effort native title projection after the first successful turn. */
  private async discoverGeneratedTitle(
    sessionId: string,
    isFirstUserTurn: boolean,
  ): Promise<void> {
    if (!isFirstUserTurn || this.titleAttempts.has(sessionId)) return;
    try {
      const session = requireAgentSession(this.dependencies.database, sessionId);
      if (session.titleSource !== undefined && session.titleSource !== "provisional") {
        return;
      }
      const runtime = this.host.runtime(sessionId);
      const runtimeSessionId = runtime?.runtimeSessionId?.(sessionId) ?? null;
      if (runtime === undefined || runtimeSessionId === null || runtime.getTitle === undefined) {
        return;
      }
      this.titleAttempts.add(sessionId);
      const nativeTitle = await this.host.getTitle(sessionId);
      if (nativeTitle === null || nativeTitle.title.trim().length === 0) return;
      const result = setGeneratedAgentSessionTitleIfProvisional(
        this.dependencies.database,
        sessionId,
        nativeTitle.title,
      );
      if (result.updated) {
        // Reuse the existing idle event so the Web query invalidation path
        // refreshes the selected view and the conversation list.
        this.broadcast(sessionId, { type: "status", status: "idle" });
      }
    } catch {
      // Native title discovery is secondary metadata; never affect the turn.
    }
  }

  private clearInteractionResolutions(sessionId: string): void {
    const prefix = `${sessionId}\u0000`;
    for (const key of this.emittedInteractionResolutions) {
      if (key.startsWith(prefix)) this.emittedInteractionResolutions.delete(key);
    }
  }

  /** Persist only LoongBoard-normalized rows (plan 13.5). */
  private persistRuntimeEvent(
    sessionId: string,
    event: ContractEvent,
    toolMessageIds: Map<string, string>,
  ): void {
    switch (event.type) {
      case "assistant.completed":
        if (event.markdown.length > 0) {
          appendAgentMessage(this.dependencies.database, {
            sessionId,
            role: "assistant",
            contentMarkdown: event.markdown,
          });
        }
        break;
      case "tool.started": {
        const message = appendAgentMessage(this.dependencies.database, {
          sessionId,
          role: "tool",
          contentMarkdown: `**${event.name}**`,
          metadata: { callId: event.callId, name: event.name, status: "running" },
        });
        toolMessageIds.set(event.callId, message.id);
        break;
      }
      case "tool.completed": {
        const existingId = toolMessageIds.get(event.callId);
        if (existingId !== undefined) {
          updateAgentMessage(this.dependencies.database, existingId, {
            contentMarkdown: event.isError
              ? `**${event.name}** failed${event.summary !== undefined ? ` — ${event.summary}` : ""}`
              : event.summary !== undefined
                ? `**${event.name}**: ${event.summary}`
                : `**${event.name}**`,
            metadata: {
              callId: event.callId,
              name: event.name,
              status: "done",
              isError: event.isError,
            },
          });
        }
        break;
      }
      case "interaction.requested":
        appendAgentMessage(this.dependencies.database, {
          sessionId,
          role: "system-status",
          contentMarkdown: `Approval requested: ${event.title}`,
          metadata: {
            type: event.type,
            requestId: event.requestId,
            kind: event.kind,
            ...(event.description !== undefined
              ? { description: event.description }
              : {}),
            options: event.options,
          },
        });
        break;
      case "interaction.resolved":
        appendAgentMessage(this.dependencies.database, {
          sessionId,
          role: "system-status",
          contentMarkdown: `Approval resolved: ${event.requestId}`,
          metadata: { type: event.type, requestId: event.requestId },
        });
        break;
      case "error":
        appendAgentMessage(this.dependencies.database, {
          sessionId,
          role: "system-status",
          contentMarkdown: `Run error: ${event.message}`,
        });
        break;
      default:
        break;
    }
  }

  private async prepareWorkspace(
    sessionId: string,
    scope: AgentScope,
  ): Promise<{ path: string }> {
    const { database } = this.dependencies;
    if (scope.kind === "pr") {
      const repository = requireEnabledRepository(database, scope.repositoryId ?? "");
      const targetSha = scope.targetSha;
      if (targetSha === undefined) {
        throw new Error("PR agent scope is missing targetSha");
      }
      const prNumber = scope.prNumber;
      if (prNumber === undefined) {
        throw new Error("PR agent scope is missing prNumber");
      }
      const fallbackSlots = repository.worktreeSlots;
      const configuredSlots = validateWorktreeSlotCapacity(
        repository.id,
        await (this.dependencies.worktreeSlotCapacity?.(
          repository.id,
          fallbackSlots,
        ) ?? fallbackSlots),
      );
      const busySlotPaths = listBusyWorkspacePaths(database, repository.id);
      const slotRows = listWorktreeSlots(database, repository.id);
      const slot: AllocatedSlot = await this.worktreePool.allocate({
        mainRepositoryPath: repository.localPath,
        poolRoot: join(this.dependencies.worktreesPath, repository.key),
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
          recordWorktreeSlotUse(database, {
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
        requireEnabledRepository(database, scope.repositoryId);
        return {
          path: this.dependencies.domainWorkspaceRoot ?? this.dependencies.knowledgePath ?? process.cwd(),
        };
      }
      // Issue chats run in the repository root (plan 14); no worktree.
      const repository = requireEnabledRepository(database, scope.repositoryId);
      return { path: repository.localPath };
    }
    // Knowledge/general chats run in the knowledge root by default.
    return { path: this.dependencies.knowledgePath ?? process.cwd() };
  }

  private broadcast(sessionId: string, event: ContractEvent): void {
    const set = this.subscribers.get(sessionId);
    if (set === undefined || set.size === 0) return;
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const connection of set) {
      if (connection.closed) continue;
      try {
        connection.reply.raw.write(payload);
      } catch {
        connection.closed = true;
      }
    }
  }
}

export function registerAgentRoutes(
  app: FastifyInstance,
  controller: AgentChatController,
): void {
  app.post("/api/agent-sessions", async (request, reply) => {
    const body = parseRequest(agentSessionCreateSchema, request.body);
    const result = await controller.ensureSession(body);
    return sendParsed(reply, 200, agentSessionResponseSchema, result);
  });

  app.get("/api/agent-sessions", async (request, reply) => {
    const query = parseRequest(agentSessionsQuerySchema, request.query);
    const items = controller.listSessions(query);
    return sendParsed(reply, 200, agentSessionsResponseSchema, { items });
  });

  app.get("/api/agent-sessions/:id", async (request, reply) => {
    const { id } = parseRequest(agentParamsSchema, request.params);
    const result = await controller.view(id);
    return sendParsed(reply, 200, agentSessionResponseSchema, result);
  });

  app.get("/api/agent-sessions/:id/messages", async (request, reply) => {
    const { id } = parseRequest(agentParamsSchema, request.params);
    const result = controller.listMessages(id);
    return sendParsed(reply, 200, agentMessagesResponseSchema, result);
  });

  app.patch("/api/agent-sessions/:id", async (request, reply) => {
    const { id } = parseRequest(agentParamsSchema, request.params);
    const body = parseRequest(agentSessionUpdateSchema, request.body);
    const result = await controller.updateSession(id, body);
    return sendParsed(reply, 200, agentSessionResponseSchema, result);
  });

  app.delete("/api/agent-sessions/:id", async (request, reply) => {
    const { id } = parseRequest(agentParamsSchema, request.params);
    const result = await controller.deleteSession(id);
    return sendParsed(reply, 200, agentSessionDeleteResponseSchema, result);
  });

  app.post("/api/agent-sessions/:id/messages", async (request, reply) => {
    const { id } = parseRequest(agentParamsSchema, request.params);
    const body = parseRequest(agentMessageCreateSchema, request.body);
    const accepted = await controller.acceptMessage(id, body.content);
    return sendParsed(reply, 201, agentMessageAcceptedSchema, accepted);
  });

  app.post("/api/agent-sessions/:id/interactions/:requestId", async (request, reply) => {
    const { id, requestId } = parseRequest(agentInteractionParamsSchema, request.params);
    const { value } = parseRequest(agentInteractionResponseSchema, request.body);
    await controller.respond(id, requestId, value);
    return reply.code(204).send();
  });

  app.post("/api/agent-sessions/:id/workspace", async (request, reply) => {
    const { id } = parseRequest(agentParamsSchema, request.params);
    const result = await controller.syncWorkspace(id);
    return sendParsed(reply, 200, agentSessionResponseSchema, result);
  });

  app.get("/api/agent-sessions/:id/events", (request, reply) => {
    const { id } = parseRequest(agentParamsSchema, request.params);
    controller.require(id);
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    reply.raw.write("retry: 3000\n\n");
    const unsubscribe = controller.subscribe(id, reply);
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(": ping\n\n");
      } catch {
        unsubscribe();
        clearInterval(heartbeat);
      }
    }, 15_000);
    reply.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
    return reply;
  });

  app.post("/api/agent-sessions/:id/cancel", async (request, reply) => {
    const { id } = parseRequest(agentParamsSchema, request.params);
    const result = await controller.cancel(id);
    return sendParsed(reply, 200, agentSessionResponseSchema, result);
  });
}
