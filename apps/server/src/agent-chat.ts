import { DSHRuntime } from "@loongboard/agent-runtime-dsh";
import {
  AgentRuntimeHost,
  type AgentRuntime,
  type AgentSessionSpec,
} from "@loongboard/agent-runtime";
import {
  agentMessageAcceptedSchema,
  agentMessageCreateSchema,
  agentMessagesResponseSchema,
  agentInteractionParamsSchema,
  agentInteractionResponseSchema,
  agentParamsSchema,
  agentSessionCreateSchema,
  agentSessionDeleteResponseSchema,
  agentSessionResponseSchema,
  agentSessionUpdateSchema,
  agentSessionsQuerySchema,
  agentSessionsResponseSchema,
  type AgentMessageAccepted,
  type AgentRuntimeCapabilities,
  type AgentSessionCreate,
  type AgentSessionSummary,
  type AgentSessionUpdate,
  type AgentSessionsQuery,
} from "@loongboard/contracts";
import type { DatabaseClient } from "@loongboard/database";
import { WorktreePool } from "@loongboard/git-workspace";
import type { FastifyInstance, FastifyReply } from "fastify";

import { AgentEventHub } from "./agent-event-hub.js";
import {
  AgentSessionService,
  type AgentRuntimeDefaults,
  type AgentSessionView,
  type WorktreeSlotCapacityResolver,
} from "./agent-session-service.js";
import {
  AgentTurnService,
  AgentTurnBusyError,
} from "./agent-turn-service.js";
import { AgentSessionHomeCleaner } from "./agent-session-home.js";
import { parseRequest, sendParsed } from "./route-helpers.js";
import { WorkspaceRunCoordinator } from "./workspace-run-coordinator.js";

export { AgentSessionNotFoundError } from "@loongboard/database";
export {
  AGENT_TITLE_RETRY_COOLDOWN_MS,
  MAX_WORKTREE_SLOTS,
  WorkspaceRevisionMismatchError,
} from "./agent-session-service.js";
export {
  AgentInteractionUnavailableError,
  AgentTurnBusyError,
  WorkspaceRunBusyError,
} from "./agent-turn-service.js";
export type {
  AgentRuntimeDefaults,
  AgentSessionView,
  WorktreeSlotCapacityResolver,
} from "./agent-session-service.js";

export interface AgentChatDependencies {
  database: DatabaseClient;
  /** Shared in-process ownership guard for every agent workspace. */
  workspaceRuns: WorkspaceRunCoordinator;
  /** Root that holds per-session DSH homes (system/.loong/agent-sessions). */
  agentSessionsPath: string;
  /** Root that holds per-repository worktree pools (system/.worktrees). */
  worktreesPath: string;
  /** Knowledge Markdown root used by Knowledge content services. */
  knowledgePath?: string;
  /** Personal Data repository root used by general/knowledge Agent chats. */
  personalDataPath?: string;
  /** System root used by Domain conversations to edit JSON/prompt files. */
  domainWorkspaceRoot?: string;
  /** Optional pool override (tests inject a gated/fake pool). */
  worktreePool?: WorktreePool;
  /** Runtime Settings authority; the DB/system value is only the fallback. */
  worktreeSlotCapacity?: WorktreeSlotCapacityResolver;
  defaults: AgentRuntimeDefaults;
  /** Optional runtime factory override (tests inject a scripted runtime). */
  runtimeFactory?: (spec: AgentSessionSpec) => AgentRuntime;
  /** Provider secrets delivered to the DSH native credential boundary. */
  credentials?: () => Promise<Record<string, string>>;
  /** Injectable clock used for non-blocking title retry cooldown tests. */
  now?: () => Date;
}

function defaultRuntimeFactory(
  credentials?: () => Promise<Record<string, string>>,
): (spec: AgentSessionSpec) => AgentRuntime {
  // The DSH web host owns permission presets and approval handling. The child
  // inherits the parent environment only so runtime credentials can reach
  // DSH's own provider settings; GitHub credentials are removed below.
  return () => {
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
 * Public Agent orchestration facade for HTTP routes, scheduler, Knowledge,
 * and runtime-settings callers. Substantive work lives in the focused
 * session, turn, and event services below this boundary.
 */
export class AgentChatController {
  private readonly sessions: AgentSessionService;
  private readonly turns: AgentTurnService;
  private readonly events: AgentEventHub;

  constructor(dependencies: AgentChatDependencies) {
    const host = new AgentRuntimeHost(
      dependencies.runtimeFactory ?? defaultRuntimeFactory(dependencies.credentials),
      dependencies.defaults.idleProcessMinutes * 60_000,
    );
    const sessionHomeCleaner = new AgentSessionHomeCleaner(dependencies.agentSessionsPath);
    const worktreePool = dependencies.worktreePool ?? new WorktreePool();
    this.events = new AgentEventHub();
    this.sessions = new AgentSessionService({
      database: dependencies.database,
      host,
      sessionHomeCleaner,
      worktreePool,
      agentSessionsPath: dependencies.agentSessionsPath,
      worktreesPath: dependencies.worktreesPath,
      knowledgePath: dependencies.knowledgePath,
      personalDataPath: dependencies.personalDataPath,
      domainWorkspaceRoot: dependencies.domainWorkspaceRoot,
      worktreeSlotCapacity: dependencies.worktreeSlotCapacity,
      defaults: dependencies.defaults,
      now: dependencies.now,
    });
    this.turns = new AgentTurnService({
      database: dependencies.database,
      workspaceRuns: dependencies.workspaceRuns,
      sessions: this.sessions,
      events: this.events,
    });
  }

  ensureSession(body: AgentSessionCreate): Promise<AgentSessionView> {
    return this.sessions.ensureSession(body);
  }

  ensureScheduledSession(input: {
    taskId: string;
    runId: string;
    workspacePath: string;
    provider: string;
    model: string;
    reasoningEffort: string;
    title?: string;
  }): Promise<AgentSessionSummary> {
    return this.sessions.ensureScheduledSession(input);
  }

  async deleteSession(sessionId: string): Promise<{ deleted: true }> {
    if (this.turns.isRunning(sessionId)) {
      throw new AgentTurnBusyError(sessionId);
    }
    const result = await this.sessions.deleteSession(sessionId);
    // Keep the required cleanup ordering: preflight -> runtime restart -> DB
    // delete -> home removal (inside the session service) -> SSE close.
    this.events.clearSession(sessionId);
    return result;
  }

  listSessions(query: AgentSessionsQuery): AgentSessionSummary[] {
    return this.sessions.listSessions(query);
  }

  async updateSession(
    sessionId: string,
    patch: AgentSessionUpdate,
  ): Promise<AgentSessionView> {
    if (this.turns.isRunning(sessionId)) {
      throw new AgentTurnBusyError(sessionId);
    }
    return this.sessions.updateSession(sessionId, patch);
  }

  discoverCapabilities(): Promise<AgentRuntimeCapabilities | null> {
    return this.sessions.discoverCapabilities();
  }

  health(): { status: "ok"; activeSessions: number; idleCloseMs: number } {
    return this.sessions.health();
  }

  updateDefaults(patch: {
    provider?: string;
    model?: string;
    reasoningEffort?: string;
    idleProcessMinutes?: number;
  }): AgentRuntimeDefaults {
    return this.sessions.updateDefaults(patch);
  }

  updateRuntimeSettings(patch: {
    defaultProvider?: string | null;
    defaultModel?: string | null;
    defaultReasoning?: string | null;
    retentionMinutes?: number;
  }): void {
    this.sessions.updateRuntimeSettings(patch);
  }

  listMessages(sessionId: string): { items: ReturnType<AgentSessionService["listMessages"]>["items"] } {
    return this.sessions.listMessages(sessionId);
  }

  view(sessionId: string): Promise<AgentSessionView> {
    return this.sessions.view(sessionId);
  }

  async syncWorkspace(sessionId: string): Promise<AgentSessionView> {
    if (this.turns.isRunning(sessionId)) {
      throw new AgentTurnBusyError(sessionId);
    }
    return this.sessions.syncWorkspace(sessionId);
  }

  require(sessionId: string): AgentSessionSummary {
    return this.sessions.require(sessionId);
  }

  acceptMessage(sessionId: string, content: string): Promise<AgentMessageAccepted> {
    return this.turns.acceptMessage(sessionId, content);
  }

  runSessionTurn(
    sessionId: string,
    prompt: string,
    options: { workspaceOwned?: boolean } = {},
  ): Promise<AgentSessionSummary> {
    return this.turns.runSessionTurn(sessionId, prompt, options);
  }

  subscribe(sessionId: string, reply: FastifyReply): () => void {
    return this.events.subscribe(sessionId, reply);
  }

  cancel(sessionId: string): Promise<AgentSessionView> {
    return this.turns.cancel(sessionId);
  }

  respond(sessionId: string, requestId: string, value: string): Promise<void> {
    return this.turns.respond(sessionId, requestId, value);
  }

  isRunning(sessionId: string): boolean {
    return this.turns.isRunning(sessionId);
  }

  async close(): Promise<void> {
    await this.turns.close();
    await this.events.close();
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
