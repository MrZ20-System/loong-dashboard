import { mkdirSync } from "node:fs";
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
  touchAgentSession,
  updateAgentMessage,
  updateAgentSession,
  type DatabaseClient,
} from "@loongboard/database";
import {
  agentMessageAcceptedSchema,
  agentMessageCreateSchema,
  agentMessagesResponseSchema,
  agentParamsSchema,
  agentRuntimeEventSchema,
  agentSessionCreateSchema,
  agentSessionResponseSchema,
  agentSessionsQuerySchema,
  agentSessionsResponseSchema,
  type AgentMessageAccepted,
  type AgentRuntimeEvent as ContractEvent,
  type AgentScope,
  type AgentSessionCreate,
  type AgentSessionSummary,
  type AgentSessionsQuery,
} from "@loongboard/contracts";
import { WorktreePool, type AllocatedSlot } from "@loongboard/git-workspace";
import type { FastifyInstance, FastifyReply } from "fastify";

import { parseRequest, sendParsed } from "./route-helpers.js";
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
  return "general";
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
  /** Optional pool override (tests inject a gated/fake pool). */
  worktreePool?: WorktreePool;
  defaults: {
    provider: string;
    model: string;
    reasoningEffort: string;
    idleProcessMinutes: number;
  };
  /** Optional runtime factory override (tests inject a scripted runtime). */
  runtimeFactory?: (spec: AgentSessionSpec) => AgentRuntime;
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

function defaultRuntimeFactory(): (spec: AgentSessionSpec) => AgentRuntime {
  // The plan grants the DSH child full access on this trusted machine and
  // lets it inherit the parent's model credentials (plan 3.5). The child
  // environment replaces the parent entirely, so spread it first.
  return () =>
    new DSHRuntime({
      env: {
        ...process.env,
        DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE ?? "danger-full-access",
      },
    });
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
  private readonly subscribers = new Map<string, Set<SseConnection>>();
  private readonly runningTurns = new Map<string, Promise<void>>();
  private readonly cancelled = new Set<string>();
  private readonly sessionCreates = new Map<string, Promise<AgentSessionView>>();
  private readonly worktreePool: WorktreePool;

  constructor(private readonly dependencies: AgentChatDependencies) {
    const idleMs = dependencies.defaults.idleProcessMinutes * 60_000;
    this.host = new AgentRuntimeHost(
      dependencies.runtimeFactory ?? defaultRuntimeFactory(),
      idleMs,
    );
    this.worktreePool = dependencies.worktreePool ?? new WorktreePool();
  }

  async ensureSession(body: AgentSessionCreate): Promise<AgentSessionView> {
    const { database } = this.dependencies;
    const existing = findAgentSession(database, body.scope);
    if (existing !== null) {
      touchAgentSession(database, existing.id);
      return this.viewFor(existing);
    }
    // Single-flight per scope: two StrictMode/concurrent opens must share one
    // allocation and one persisted session instead of racing the first
    // worktree checkout.
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
      now: new Date().toISOString(),
    });
    return this.viewFor(session);
  }

  /** Sessions matching an optional scope filter, newest activity first. */
  listSessions(query: AgentSessionsQuery): AgentSessionSummary[] {
    return listAgentSessions(this.dependencies.database, {
      scopeType: query.scopeType,
      repositoryId: query.repositoryId,
      prNumber: query.prNumber,
      issueNumber: query.issueNumber,
      knowledgeDocumentId: query.knowledgeDocumentId,
    });
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
    // The DSH process pins its cwd when it starts; stop it before the
    // worktree is switched so the next turn starts in the new workspace.
    await this.host.stop(sessionId);
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
    await this.host.stop(sessionId);
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

  isRunning(sessionId: string): boolean {
    return this.runningTurns.has(sessionId);
  }

  async close(): Promise<void> {
    await this.host.close();
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
    // Only an idle session has a known-clean DSH process boundary. A session
    // marked interrupted/error may hold the id of a DSH session whose durable
    // log was cut mid-turn; reusing it would make every later turn fail the
    // same way, so those turns start a fresh runtime session instead.
    const resumeRuntimeSessionId =
      session.status === "idle" ? (session.dshSessionId ?? undefined) : undefined;
    if (session.status !== "idle" && session.dshSessionId !== null) {
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
    mkdirSync(session.dshHomePath, { recursive: true });
    updateAgentSession(this.dependencies.database, session.id, { status: "running" });
    this.host.beginRun(session.id);
    let receivedCompletion = false;
    const toolMessageIds = new Map<string, string>();
    try {
      const runtime = this.host.ensure(spec);
      this.broadcast(session.id, { type: "status", status: "starting" });
      for await (const event of runtime.run(spec, prompt)) {
        if (this.cancelled.has(session.id)) break;
        const normalized = agentRuntimeEventSchema.parse(event);
        this.persistRuntimeEvent(session.id, normalized, toolMessageIds);
        if (normalized.type === "assistant.completed") receivedCompletion = true;
        const tracked = runtime as AgentRuntime & {
          runtimeSessionId?: (sessionId: string) => string | null;
        };
        const runtimeSessionId =
          typeof tracked.runtimeSessionId === "function"
            ? tracked.runtimeSessionId(session.id)
            : null;
        if (runtimeSessionId !== null && normalized.type === "assistant.completed") {
          updateAgentSession(this.dependencies.database, session.id, {
            dshSessionId: runtimeSessionId,
          });
        }
        this.broadcast(session.id, normalized);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.broadcast(session.id, { type: "error", message });
      appendAgentMessage(this.dependencies.database, {
        sessionId: session.id,
        role: "system-status",
        contentMarkdown: message,
      });
    } finally {
      this.host.endRun(session.id);
      const interrupted = this.cancelled.has(session.id);
      const nextStatus = interrupted ? "interrupted" : receivedCompletion ? "idle" : "error";
      updateAgentSession(this.dependencies.database, session.id, {
        status: nextStatus,
        // Only a completed turn leaves a DSH session that a fresh process can
        // resume; interrupted and failed turns must not reuse its session id.
        ...(nextStatus === "idle" ? {} : { dshSessionId: null }),
      });
      this.broadcast(session.id, { type: "status", status: "idle" });
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
      const busySlotPaths = listBusyWorkspacePaths(database, repository.id);
      const slotRows = listWorktreeSlots(database, repository.id);
      const slot: AllocatedSlot = await this.worktreePool.allocate({
        mainRepositoryPath: repository.localPath,
        poolRoot: join(this.dependencies.worktreesPath, repository.key),
        slotCount: repository.worktreeSlots,
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

  app.post("/api/agent-sessions/:id/messages", async (request, reply) => {
    const { id } = parseRequest(agentParamsSchema, request.params);
    const body = parseRequest(agentMessageCreateSchema, request.body);
    const accepted = await controller.acceptMessage(id, body.content);
    return sendParsed(reply, 201, agentMessageAcceptedSchema, accepted);
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
