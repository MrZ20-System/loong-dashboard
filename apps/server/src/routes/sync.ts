import {
  getRepositoryHistoryState,
  getRepositorySyncStatus,
  getSyncRun,
  SyncRunNotFoundError,
  listSyncRuns,
  type DatabaseClient,
  type SyncRun,
} from "@loongboard/database";
import {
  fetchPullRequestParamsSchema,
  historyResponseSchema,
  historySettingsUpdateSchema,
  repositoryParamsSchema,
  syncAcceptedResponseSchema,
  syncRequestSchema,
  syncRunAcceptedSchema,
  syncRunParamsSchema,
  syncRunSchema,
  syncRunsQuerySchema,
  syncRunsResponseSchema,
  syncStatusResponseSchema,
  type HistorySettingsUpdate,
  type SyncRequest,
} from "@loongboard/contracts";
import type { FastifyInstance } from "fastify";

import {
  assertEmptyRequestBody,
  InvalidRequestError,
  parseRequest,
  sendParsed,
} from "../route-helpers.js";
import type { SyncCoordinator } from "../sync-coordinator.js";

export interface SyncRoutesDependencies {
  database: DatabaseClient;
  syncCoordinator: SyncCoordinator;
}

/** Repository synchronization starts, history controls, and durable status. */
export function registerSyncRoutes(
  app: FastifyInstance,
  dependencies: SyncRoutesDependencies,
): void {
  const { database, syncCoordinator } = dependencies;

  app.post("/api/repositories/:id/sync", async (request, reply) => {
    const { id } = parseRequest(repositoryParamsSchema, request.params);
    const body = request.body === undefined
      ? {}
      : parseRequest(syncRequestSchema, request.body);
    const run = startRequestedSync(syncCoordinator, id, body);
    return sendParsed(reply, 202, syncAcceptedResponseSchema, {
      repositoryId: run.repositoryId,
      syncRunId: run.syncRunId,
      status: "accepted",
    });
  });

  app.get("/api/repositories/:id/sync-runs", async (request, reply) => {
    const { id } = parseRequest(repositoryParamsSchema, request.params);
    const query = parseRequest(syncRunsQuerySchema, request.query);
    return sendParsed(reply, 200, syncRunsResponseSchema, {
      items: listSyncRuns(database, id, query.limit),
    });
  });

  app.get("/api/repositories/:repositoryId/sync-runs/:runId", async (request, reply) => {
    const params = parseRequest(syncRunParamsSchema, request.params);
    const run = getSyncRun(database, params.runId);
    if (run.repositoryId !== params.repositoryId) {
      throw new SyncRunNotFoundError(params.runId);
    }
    return sendParsed(reply, 200, syncRunSchema, run);
  });

  app.get("/api/repositories/:id/sync-history", async (request, reply) => {
    const { id } = parseRequest(repositoryParamsSchema, request.params);
    return sendParsed(reply, 200, historyResponseSchema, {
      settings: historySettings(database, id),
    });
  });

  app.put("/api/repositories/:id/sync-history", async (request, reply) => {
    const { id } = parseRequest(repositoryParamsSchema, request.params);
    const update = parseRequest(historySettingsUpdateSchema, request.body) as HistorySettingsUpdate;
    syncCoordinator.configureHistory(id, update);
    return sendParsed(reply, 200, historyResponseSchema, {
      settings: historySettings(database, id),
    });
  });

  app.post("/api/repositories/:id/sync-history/pause", async (request, reply) => {
    assertEmptyRequestBody(request.body);
    const { id } = parseRequest(repositoryParamsSchema, request.params);
    syncCoordinator.pauseHistory(id);
    return reply.code(204).send();
  });

  app.post("/api/repositories/:id/sync-history/continue", async (request, reply) => {
    assertEmptyRequestBody(request.body);
    const { id } = parseRequest(repositoryParamsSchema, request.params);
    const run = syncCoordinator.resumeHistory(id);
    return sendParsed(reply, 202, syncRunAcceptedSchema, {
      repositoryId: run.repositoryId,
      syncRunId: run.syncRunId,
      status: "accepted",
    });
  });

  app.post("/api/repositories/:repositoryId/pulls/:number/fetch", async (request, reply) => {
    assertEmptyRequestBody(request.body);
    const { repositoryId, number } = parseRequest(fetchPullRequestParamsSchema, request.params);
    const run = syncCoordinator.startFetchPullRequest(repositoryId, number, { trigger: "api" });
    return sendParsed(reply, 202, syncRunAcceptedSchema, {
      repositoryId: run.repositoryId,
      syncRunId: run.syncRunId,
      status: "accepted",
    });
  });

  app.get("/api/repositories/:id/sync-status", async (request, reply) => {
    const { id } = parseRequest(repositoryParamsSchema, request.params);
    const status = getRepositorySyncStatus(database, id);
    const response = {
      repositoryId: status.repositoryId,
      status: status.status,
      pullRequests: toSyncStreamResponse(status.pullRequests),
      issues: toSyncStreamResponse(status.issues),
    };
    return sendParsed(reply, 200, syncStatusResponseSchema, response);
  });
}

function historySettings(database: DatabaseClient, repositoryId: string) {
  return ([
    getRepositoryHistoryState(database, repositoryId, "pull_request"),
    getRepositoryHistoryState(database, repositoryId, "issue"),
  ] as const).map((state) => ({
    repositoryId: state.repositoryId,
    entityKind: state.entityKind,
    targetDate: state.targetDate,
    oldestCoveredDay: state.oldestCoveredDay,
    cursor: state.cursor,
    enabled: state.enabled,
    status: state.status,
    lastRunId: state.lastRunId,
    lastError: state.lastError,
    updatedAt: state.updatedAt,
  }));
}

function startRequestedSync(
  coordinator: SyncCoordinator,
  repositoryId: string,
  request: SyncRequest,
): SyncRun {
  const kind = request.kind ?? "forward";
  if (kind === "forward") return coordinator.start(repositoryId, "api");
  if (kind === "history") {
    return coordinator.startHistory(repositoryId, {
      targetDate: request.targetDate,
      // HTTP callers cannot impersonate scheduler/system triggers.
      trigger: "api",
    });
  }
  if (request.number === undefined) {
    throw new InvalidRequestError("Fetch PR sync requires a positive number");
  }
  return coordinator.startFetchPullRequest(repositoryId, request.number, { trigger: "api" });
}

function toSyncStreamResponse(state: {
  entityKind: "pull_request" | "issue";
  status: "idle" | "running" | "failed";
  watermarkUpdatedAt: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  rateLimitRemaining: number | null;
  rateLimitResetAt: string | null;
}): unknown {
  return {
    entityKind: state.entityKind,
    status: state.status,
    watermarkUpdatedAt: state.watermarkUpdatedAt,
    lastAttemptAt: state.lastAttemptAt,
    lastSuccessAt: state.lastSuccessAt,
    lastError: state.lastError,
    rateLimitRemaining: state.rateLimitRemaining,
    rateLimitResetAt: state.rateLimitResetAt,
  };
}
