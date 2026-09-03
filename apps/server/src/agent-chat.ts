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

function requireEnabledRepository(database: DatabaseClient, repositoryId: string) {
  const repository = getRepository(database, repositoryId);
  if (repository === null) {
    throw new Error(`Repository is missing or disabled: ${repositoryId}`);
  }
  return repository;
}

export interface AgentChatDependencies {
  database: DatabaseClient;
  /** Root that holds per-session DSH homes (system/.loong/agent-sessions). */
  agentSessionsPath: string;
  /** Root that holds per-repository worktree pools (system/.worktrees). */
  worktreesPath: string;
  /** Knowledge root used as the cwd for knowledge/general chats. */
  knowledgePath?: string;
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
  private readonly worktreePool = new WorktreePool();

  constructor(private readonly dependencies: AgentChatDependencies) {
    const idleMs = dependencies.defaults.idleProcessMinutes * 60_000;
    this.host = new AgentRuntimeHost(
      dependencies.runtimeFactory ?? defaultRuntimeFactory(),
      idleMs,
    );
  }

  async ensureSession(body: AgentSessionCreate): Promise<AgentSessionView> {
    const { database } = this.dependencies;
    const existing = findAgentSession(database, body.scope);
    if (existing !== null) {
      touchAgentSession(database, existing.id);
      return this.viewFor(existing);
    }
    const id = `sess_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const workspace = await this.prepareWorkspace(id, body.scope);
    // Re-check after the (potentially slow) allocation so two racing opens
    // for one scope converge on the same default session.
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
    if (session.scope.kind !== "pr") return this.viewFor(session);
    const workspace = await this.prepareWorkspace(sessionId, session.scope);
    const updated =
      workspace.path === session.workspacePath
        ? session
        : updateAgentSession(this.dependencies.database, sessionId, {
            workspacePath: workspace.path,
          });
    return this.viewFor(updated);
  }

  /** Public existence check used by routes before opening an SSE stream. */
  require(sessionId: string): AgentSessionSummary {
    return requireAgentSession(this.dependencies.database, sessionId);
  }

  /** Accept a user message and start the turn in the background. */
  acceptMessage(sessionId: string, content: string): AgentMessageAccepted {
    if (this.runningTurns.has(sessionId)) {
      throw new AgentTurnBusyError(sessionId);
    }
    const session = requireAgentSession(this.dependencies.database, sessionId);
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
    });
    return { messageId: userMessage.id, status: "accepted" };
  }

  /**
   * Run (and await) one full turn on an existing session without appending a
   * user row — used by the scheduler, which persists the prompt itself so the
   * scheduled text is sent verbatim (plan 16.1).
   */
  async runSessionTurn(sessionId: string, prompt: string): Promise<AgentSessionSummary> {
    if (this.runningTurns.has(sessionId)) {
      throw new AgentTurnBusyError(sessionId);
    }
    const session = requireAgentSession(this.dependencies.database, sessionId);
    const turn = this.runTurn(session, prompt);
    this.runningTurns.set(sessionId, turn);
    try {
      await turn;
    } finally {
      this.runningTurns.delete(sessionId);
      this.cancelled.delete(sessionId);
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

  private async runTurn(session: AgentSessionSummary, prompt: string): Promise<void> {
    const spec: AgentSessionSpec = {
      sessionId: session.id,
      workspacePath: session.workspacePath,
      provider: session.provider,
      model: session.model,
      reasoningEffort: session.reasoningEffort,
      dshHomePath: session.dshHomePath,
      runtimeSessionId: session.dshSessionId ?? undefined,
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
      updateAgentSession(this.dependencies.database, session.id, {
        status: interrupted ? "interrupted" : receivedCompletion ? "idle" : "error",
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
      const busySlotPaths = listBusyWorkspacePaths(database, repository.id);
      const slot: AllocatedSlot = await this.worktreePool.allocate({
        mainRepositoryPath: repository.localPath,
        poolRoot: join(this.dependencies.worktreesPath, repository.key),
        slotCount: repository.worktreeSlots,
        prNumber: scope.prNumber ?? 0,
        targetSha,
        busySlotPaths,
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
    const accepted = controller.acceptMessage(id, body.content);
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
