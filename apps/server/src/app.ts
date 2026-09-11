import {
  getIssueActivityDays,
  getPullRequestActivityDays,
  getRepositoryHistoryState,
  getRepositorySyncStatus,
  getSyncRun,
  listSyncRuns,
  listIssues,
  listMergedPullRequests,
  listPullRequests,
  listRepositories,
  type DatabaseClient,
  type SyncRun,
  SyncRunNotFoundError,
} from "@loongboard/database";
import {
  activityDaysQuerySchema,
  activityDaysResponseSchema,
  authPasswordUpdateSchema,
  authStatusSchema,
  authUnlockRequestSchema,
  apiErrorSchema,
  healthResponseSchema,
  issueDetailSchema,
  issueParamsSchema,
  issuesQuerySchema,
  issuesResponseSchema,
  pullRequestsQuerySchema,
  mergedPullRequestsQuerySchema,
  mergedPullRequestsResponseSchema,
  pullRequestsResponseSchema,
  repositoriesResponseSchema,
  repositoryParamsSchema,
  fetchPullRequestParamsSchema,
  historyResponseSchema,
  historySettingsUpdateSchema,
  syncRequestSchema,
  syncRunSchema,
  syncRunParamsSchema,
  syncRunsQuerySchema,
  syncRunsResponseSchema,
  syncRunAcceptedSchema,
  type SyncRequest,
  type HistorySettingsUpdate,
  syncAcceptedResponseSchema,
  syncStatusResponseSchema,
  type ApiErrorCode,
  type HealthResponse,
} from "@loongboard/contracts";
import {
  LocalGitWorkspace,
  type GitWorkspace,
} from "@loongboard/git-workspace";
import type { GitHubMetadataProvider } from "@loongboard/github";
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";

import { registerDomainRoutes } from "./domains.js";
import type { DomainFileService } from "./domain-file.js";
import { registerDiffRoutes } from "./diff.js";
import {
  registerKnowledgeRoutes,
  type KnowledgeController,
} from "./knowledge.js";
import {
  registerScheduledTaskRoutes,
} from "./scheduled-tasks.js";
import type { SchedulerEngine } from "./scheduler.js";
import {
  AgentChatController,
  registerAgentRoutes,
} from "./agent-chat.js";
import {
  DomainReclassificationService,
  type DomainReclassification,
} from "./reclassification-service.js";
import {
  assertEmptyRequestBody,
  InvalidRequestError,
  parseRequest,
  sendParsed,
} from "./route-helpers.js";
import type { SyncCoordinator } from "./sync-coordinator.js";
import { IssueDetailService } from "./issue-detail-service.js";
import {
  registerSettingsRoutes,
  type SettingsController,
} from "./settings.js";
import {
  registerMetadataMaintenanceRoutes,
} from "./metadata-maintenance-routes.js";
import type { MetadataMaintenanceService } from "./metadata-maintenance.js";
import { registerProductionStaticSite } from "./static-site.js";
import {
  AuthInvalidPasswordError,
  AuthRateLimitedError,
  AuthRequiredError,
  AuthService,
} from "./auth.js";

const healthResponse: HealthResponse = healthResponseSchema.parse({
  status: "ok",
});

/** Route-level 404 for issue reads (stored metadata is SQLite-only). */
export class IssueNotFoundError extends Error {
  readonly code = "ISSUE_NOT_FOUND" as const;

  constructor(repositoryId: string, number: number) {
    super(`Issue #${number} was not found in repository ${repositoryId}`);
    this.name = "IssueNotFoundError";
  }
}

/** Explicit non-HTTP dependency set used by the app factory. */
export interface BuildAppDependencies {
  database: DatabaseClient;
  timezone: string;
  syncCoordinator: SyncCoordinator;
  /** Lazy Issue body/comment refresh; optional for cache-hit-only servers. */
  github?: GitHubMetadataProvider;
  /** Defaults to an in-process serial service owned by the app. */
  reclassification?: DomainReclassification;
  /** Defaults to a real local Git workspace. */
  gitWorkspace?: GitWorkspace;
  /** Chat controller created by the runtime; routes register only when set. */
  agentChat?: AgentChatController;
  /** Knowledge controller created by the runtime; routes register when set. */
  knowledge?: KnowledgeController;
  /** Scheduler engine and defaults; task routes register when set. */
  scheduledTasks?: {
    engine: SchedulerEngine;
    defaults: { provider: string; model: string; reasoningEffort: string };
  };
  /** File-backed Domain source/projection service. */
  domainFiles?: DomainFileService;
  /** Persistent control-center settings service. */
  settings?: SettingsController;
  /** Optional local password lock; absent keeps embedded/test apps unlocked. */
  auth?: AuthService;
  /** Bounded repository metadata archive worker. */
  metadataMaintenance?: MetadataMaintenanceService;
}

/**
 * Build the local HTTP app without opening a socket. Dependencies are passed
 * as one explicit shape so route composition cannot accidentally construct a
 * partially wired application.
 */
export interface BuildAppOptions extends FastifyServerOptions {
  /** Absolute or cwd-relative React production artifact root. */
  staticRoot?: string;
}

export function buildApp(
  dependencies: BuildAppDependencies,
  options: BuildAppOptions = {},
): FastifyInstance {
  const { database, timezone, syncCoordinator } = dependencies;
  const { staticRoot, ...fastifyOptions } = options;
  const auth = dependencies.auth ?? AuthService.disabled();
  const ownsReclassification = dependencies.reclassification === undefined;
  const reclassification =
    dependencies.reclassification ??
    new DomainReclassificationService({ database });
  const gitWorkspace = dependencies.gitWorkspace ?? new LocalGitWorkspace();
  const issueDetails = new IssueDetailService({
    database,
    ...(dependencies.github === undefined ? {} : { github: dependencies.github }),
  });
  const app = Fastify(fastifyOptions);
  configureJsonParser(app);

  app.get("/api/health", async (_request, reply) => {
    return reply.code(200).send(healthResponse);
  });
  app.get("/api/health/live", async (_request, reply) => {
    return reply.code(200).send(healthResponse);
  });

  registerAuthRoutes(app, auth);
  app.addHook("onRequest", async (request, reply) => {
    const pathname = request.url.split("?", 1)[0];
    if (!pathname.startsWith("/api/") || isPublicApiPath(pathname)) return;
    if (auth.isAuthorized(request.headers.cookie)) return;
    return reply
      .code(401)
      .type("application/json")
      .send({ error: { code: "AUTH_REQUIRED", message: "Authentication required" } });
  });

  registerStageOneRoutes(app, database, timezone, syncCoordinator, issueDetails);
  registerDomainRoutes(app, {
    database,
    reclassification,
    ...(dependencies.domainFiles === undefined
      ? {}
      : { domainFiles: dependencies.domainFiles }),
  });
  registerDiffRoutes(app, { database, gitWorkspace });
  if (dependencies.metadataMaintenance !== undefined) {
    registerMetadataMaintenanceRoutes(app, {
      service: dependencies.metadataMaintenance,
    });
  }
  if (dependencies.agentChat !== undefined) {
    registerAgentRoutes(app, dependencies.agentChat);
  }
  if (dependencies.knowledge !== undefined) {
    registerKnowledgeRoutes(app, dependencies.knowledge);
  }
  if (dependencies.scheduledTasks !== undefined) {
    registerScheduledTaskRoutes(app, {
      database,
      engine: dependencies.scheduledTasks.engine,
      defaults: dependencies.scheduledTasks.defaults,
    });
  }
  if (dependencies.settings !== undefined) {
    registerSettingsRoutes(app, { controller: dependencies.settings });
  }
  if (staticRoot !== undefined) {
    registerProductionStaticSite(app, staticRoot);
  }

  if (ownsReclassification) {
    app.addHook("onClose", async () => {
      await reclassification.close();
    });
  }

  app.setErrorHandler((error, _request, reply) => {
    if (reply.sent) return;
    const response = errorResponse(error);
    return reply
      .code(response.statusCode)
      .type("application/json")
      .send(response.body);
  });

  return app;
}

function registerStageOneRoutes(
  app: FastifyInstance,
  database: DatabaseClient,
  calendarTimeZone: string,
  syncCoordinator: SyncCoordinator,
  issueDetails: IssueDetailService,
): void {
  app.get("/api/repositories", async (_request, reply) => {
    const repositories = listRepositories(database).map((repository) => ({
      id: repository.id,
      key: repository.key,
      displayName: repository.displayName,
      githubOwner: repository.githubOwner,
      githubName: repository.githubName,
      localPath: repository.localPath,
      remoteName: repository.remoteName,
      defaultBranch: repository.defaultBranch,
      worktreeSlots: repository.worktreeSlots,
      enabled: repository.enabled,
      pullRequestCount: repository.pullRequestCount ?? 0,
      mergedPullRequestCount: repository.mergedPullRequestCount ?? 0,
      issueCount: repository.issueCount ?? 0,
    }));
    return sendParsed(reply, 200, repositoriesResponseSchema, {
      items: repositories,
    });
  });

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
    const settings = [
      getRepositoryHistoryState(database, id, "pull_request"),
      getRepositoryHistoryState(database, id, "issue"),
    ].map((state) => ({
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
    return sendParsed(reply, 200, historyResponseSchema, {
      settings,
    });
  });

  app.put("/api/repositories/:id/sync-history", async (request, reply) => {
    const { id } = parseRequest(repositoryParamsSchema, request.params);
    const update = parseRequest(historySettingsUpdateSchema, request.body) as HistorySettingsUpdate;
    if (syncCoordinator.configureHistory === undefined) {
      throw new Error("History settings are not available");
    }
    syncCoordinator.configureHistory(id, update);
    return sendParsed(reply, 200, historyResponseSchema, {
      settings: [
        getRepositoryHistoryState(database, id, "pull_request"),
        getRepositoryHistoryState(database, id, "issue"),
      ].map((state) => ({
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
      })),
    });
  });

  app.post("/api/repositories/:id/sync-history/pause", async (request, reply) => {
    assertEmptyRequestBody(request.body);
    const { id } = parseRequest(repositoryParamsSchema, request.params);
    if (syncCoordinator.pauseHistory === undefined) {
      throw new Error("History pause is not available");
    }
    syncCoordinator.pauseHistory(id);
    return reply.code(204).send();
  });

  app.post("/api/repositories/:id/sync-history/continue", async (request, reply) => {
    assertEmptyRequestBody(request.body);
    const { id } = parseRequest(repositoryParamsSchema, request.params);
    if (syncCoordinator.resumeHistory === undefined) {
      throw new Error("History continuation is not available");
    }
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
    if (syncCoordinator.startFetchPullRequest === undefined) {
      throw new Error("Single pull request fetch is not available");
    }
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

  // Register the more specific activity-days paths before list paths to keep
  // the route intent obvious to readers and route-inspection tests.
  app.get(
    "/api/repositories/:id/pulls/activity-days",
    async (request, reply) => {
      const { id } = parseRequest(repositoryParamsSchema, request.params);
      const query = parseRequest(activityDaysQuerySchema, request.query);
      const days = getPullRequestActivityDays(database, id, {
        from: query.from,
        to: query.to,
        calendarTimeZone,
      });
      return sendParsed(reply, 200, activityDaysResponseSchema, {
        days,
        calendarTimeZone,
      });
    },
  );

  app.get("/api/repositories/:id/pulls", async (request, reply) => {
    const { id } = parseRequest(repositoryParamsSchema, request.params);
    const query = parseRequest(pullRequestsQuerySchema, request.query);
    const page = listPullRequests(database, id, {
      calendarTimeZone,
      from: query.from,
      to: query.to,
      status: query.status,
      sort: query.sort,
      search: query.search,
      page: query.page,
      limit: query.limit,
      domainIds: query.domain,
      archive: query.archive ?? "current",
    });
    return sendParsed(reply, 200, pullRequestsResponseSchema, page);
  });

  app.get("/api/repositories/:id/merged", async (request, reply) => {
    const { id } = parseRequest(repositoryParamsSchema, request.params);
    const query = parseRequest(mergedPullRequestsQuerySchema, request.query);
    const page = listMergedPullRequests(database, id, {
      calendarTimeZone,
      page: query.page,
      search: query.search,
      domainIds: query.domain,
      limit: query.limit,
    });
    return sendParsed(reply, 200, mergedPullRequestsResponseSchema, page);
  });

  app.get(
    "/api/repositories/:id/issues/activity-days",
    async (request, reply) => {
      const { id } = parseRequest(repositoryParamsSchema, request.params);
      const query = parseRequest(activityDaysQuerySchema, request.query);
      const days = getIssueActivityDays(database, id, {
        from: query.from,
        to: query.to,
        calendarTimeZone,
      });
      return sendParsed(reply, 200, activityDaysResponseSchema, {
        days,
        calendarTimeZone,
      });
    },
  );

  app.get("/api/repositories/:id/issues", async (request, reply) => {
    const { id } = parseRequest(repositoryParamsSchema, request.params);
    const query = parseRequest(issuesQuerySchema, request.query);
    const page = listIssues(database, id, {
      calendarTimeZone,
      from: query.from,
      to: query.to,
      status: query.status,
      search: query.search,
      limit: query.limit,
      cursor: query.cursor,
      archive: query.archive ?? "current",
    });
    return sendParsed(reply, 200, issuesResponseSchema, page);
  });

  app.get("/api/repositories/:repositoryId/issues/:number", async (request, reply) => {
    const { repositoryId, number } = parseRequest(issueParamsSchema, request.params);
    const issue = await issueDetails.get(repositoryId, number);
    if (issue === null) throw new IssueNotFoundError(repositoryId, number);
    return sendParsed(reply, 200, issueDetailSchema, issue);
  });
}

function registerAuthRoutes(app: FastifyInstance, auth: AuthService): void {
  app.get("/api/auth/status", async (request, reply) => {
    return sendParsed(reply, 200, authStatusSchema, auth.status(request.headers.cookie));
  });

  app.post("/api/auth/unlock", async (request, reply) => {
    const { password } = parseRequest(authUnlockRequestSchema, request.body);
    try {
      const result = await auth.unlock(password);
      if (result.token !== null) {
        reply.header("Set-Cookie", auth.sessionCookie(result.token, request.protocol === "https"));
      }
      return sendParsed(reply, 200, authStatusSchema, result.status);
    } catch (error: unknown) {
      if (error instanceof AuthRateLimitedError) {
        reply.header("Retry-After", String(error.retryAfterSeconds));
      }
      throw error;
    }
  });

  app.post("/api/auth/password", async (request, reply) => {
    const { password, currentPassword } = parseRequest(authPasswordUpdateSchema, request.body);
    try {
      const result = await auth.setPassword(password, request.headers.cookie, currentPassword);
      if (result.token !== null) {
        reply.header("Set-Cookie", auth.sessionCookie(result.token, request.protocol === "https"));
      }
      return sendParsed(reply, 200, authStatusSchema, result.status);
    } catch (error: unknown) {
      if (error instanceof AuthRateLimitedError) {
        reply.header("Retry-After", String(error.retryAfterSeconds));
      }
      throw error;
    }
  });

  app.post("/api/auth/disable", async (request, reply) => {
    const result = await auth.disable(request.headers.cookie);
    reply.header("Set-Cookie", auth.clearSessionCookie(request.protocol === "https"));
    return sendParsed(reply, 200, authStatusSchema, result.status);
  });

  // Logout is intentionally idempotent and public: clearing an old cookie is
  // safe even after the password has been rotated or reset locally.
  app.post("/api/auth/logout", async (request, reply) => {
    assertEmptyRequestBody(request.body);
    reply.header("Set-Cookie", auth.clearSessionCookie(request.protocol === "https"));
    return sendParsed(reply, 200, authStatusSchema, auth.status());
  });
}

function isPublicApiPath(pathname: string): boolean {
  return pathname === "/api/health" ||
    pathname === "/api/health/live" ||
    pathname === "/api/auth/status" ||
    pathname === "/api/auth/unlock";
}

function configureJsonParser(app: FastifyInstance): void {
  const defaultJsonParser = app.getDefaultJsonParser("error", "ignore");
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (request, payload, done) => {
      if (payload.length === 0) {
        done(null, undefined);
        return;
      }
      defaultJsonParser(request, payload as string, done);
    },
  );
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

function startRequestedSync(
  coordinator: SyncCoordinator,
  repositoryId: string,
  request: SyncRequest,
): SyncRun {
  const kind = request.kind ?? "forward";
  if (kind === "forward") return coordinator.start(repositoryId, "api");
  if (kind === "history") {
    if (coordinator.startHistory === undefined) {
      throw new Error("History sync is not available");
    }
    return coordinator.startHistory(repositoryId, {
      targetDate: request.targetDate,
      // HTTP callers cannot impersonate scheduler/system triggers.
      trigger: "api",
    });
  }
  if (request.number === undefined) {
    throw new InvalidRequestError("Fetch PR sync requires a positive number");
  }
  if (coordinator.startFetchPullRequest === undefined) {
    throw new Error("Single pull request fetch is not available");
  }
  return coordinator.startFetchPullRequest(repositoryId, request.number, { trigger: "api" });
}

function errorResponse(error: unknown): {
  statusCode: number;
  body: unknown;
} {
  const code = errorCode(error);
  const statusCode =
    code === "INVALID_REQUEST"
      ? 400
      : code === "INVALID_CURSOR"
        ? 400
          : code === "REPOSITORY_NOT_FOUND" ||
            code === "DOMAIN_NOT_FOUND" ||
            code === "DOMAIN_VERSION_NOT_FOUND" ||
            code === "PULL_REQUEST_NOT_FOUND" ||
            code === "FILE_NOT_FOUND" ||
            code === "ISSUE_NOT_FOUND" ||
            code === "KNOWLEDGE_DOCUMENT_NOT_FOUND" ||
            code === "KNOWLEDGE_VERSION_NOT_FOUND" ||
            code === "SCHEDULED_TASK_NOT_FOUND" ||
            code === "AGENT_SESSION_NOT_FOUND" ||
            code === "SYNC_RUN_NOT_FOUND" ||
            code === "MAINTENANCE_RUN_NOT_FOUND"
          ? 404
            : code === "AUTH_REQUIRED" || code === "AUTH_INVALID_PASSWORD"
              ? 401
              : code === "AUTH_RATE_LIMITED"
                ? 429
                : code === "SYNC_ALREADY_RUNNING" ||
              code === "HISTORY_PAUSED" ||
              code === "DOMAIN_NAME_CONFLICT" ||
              code === "AGENT_TURN_BUSY" ||
              code === "AGENT_INTERACTION_UNAVAILABLE" ||
              code === "WORKSPACE_BUSY" ||
              code === "WORKSPACE_REVISION_MISMATCH" ||
              code === "KNOWLEDGE_DOCUMENT_CONFLICT" ||
              code === "WORKTREE_POOL_EXHAUSTED" ||
              code === "SCHEDULED_TASK_WORKSPACE_BUSY"
            ? 409
            : 500;
  const message = requestErrorMessage(error, code);
  const body = apiErrorSchema.parse({ error: { code, message } });
  return { statusCode, body };
}

function errorCode(error: unknown): ApiErrorCode {
  if (
    error instanceof InvalidRequestError ||
    isMalformedJsonError(error) ||
    isUnsupportedContentTypeError(error)
  ) {
    return "INVALID_REQUEST";
  }
  if (hasCode(error, "INVALID_CURSOR")) return "INVALID_CURSOR";
  if (hasCode(error, "REPOSITORY_NOT_FOUND")) return "REPOSITORY_NOT_FOUND";
  if (hasCode(error, "DOMAIN_NOT_FOUND")) return "DOMAIN_NOT_FOUND";
  if (hasCode(error, "DOMAIN_VERSION_NOT_FOUND")) return "DOMAIN_VERSION_NOT_FOUND";
  if (hasCode(error, "DOMAIN_NAME_CONFLICT")) return "DOMAIN_NAME_CONFLICT";
  if (hasCode(error, "PULL_REQUEST_NOT_FOUND")) {
    return "PULL_REQUEST_NOT_FOUND";
  }
  if (hasCode(error, "FILE_NOT_FOUND")) return "FILE_NOT_FOUND";
  if (hasCode(error, "ISSUE_NOT_FOUND")) return "ISSUE_NOT_FOUND";
  if (hasCode(error, "KNOWLEDGE_DOCUMENT_NOT_FOUND")) return "KNOWLEDGE_DOCUMENT_NOT_FOUND";
  if (hasCode(error, "KNOWLEDGE_DOCUMENT_CONFLICT")) return "KNOWLEDGE_DOCUMENT_CONFLICT";
  if (hasCode(error, "KNOWLEDGE_VERSION_NOT_FOUND")) return "KNOWLEDGE_VERSION_NOT_FOUND";
  if (hasCode(error, "SCHEDULED_TASK_NOT_FOUND")) return "SCHEDULED_TASK_NOT_FOUND";
  if (hasCode(error, "SCHEDULED_TASK_WORKSPACE_BUSY")) return "SCHEDULED_TASK_WORKSPACE_BUSY";
  if (hasCode(error, "AGENT_SESSION_NOT_FOUND")) return "AGENT_SESSION_NOT_FOUND";
  if (hasCode(error, "AGENT_TURN_BUSY")) return "AGENT_TURN_BUSY";
  if (hasCode(error, "AGENT_INTERACTION_UNAVAILABLE")) {
    return "AGENT_INTERACTION_UNAVAILABLE";
  }
  if (hasCode(error, "WORKSPACE_BUSY")) return "WORKSPACE_BUSY";
  if (hasCode(error, "WORKSPACE_REVISION_MISMATCH")) {
    return "WORKSPACE_REVISION_MISMATCH";
  }
  if (hasCode(error, "WORKTREE_POOL_EXHAUSTED")) return "WORKTREE_POOL_EXHAUSTED";
  if (hasCode(error, "SYNC_ALREADY_RUNNING")) return "SYNC_ALREADY_RUNNING";
  if (hasCode(error, "HISTORY_PAUSED")) return "HISTORY_PAUSED";
  if (error instanceof AuthRequiredError || hasCode(error, "AUTH_REQUIRED")) {
    return "AUTH_REQUIRED";
  }
  if (error instanceof AuthInvalidPasswordError || hasCode(error, "AUTH_INVALID_PASSWORD")) {
    return "AUTH_INVALID_PASSWORD";
  }
  if (error instanceof AuthRateLimitedError || hasCode(error, "AUTH_RATE_LIMITED")) {
    return "AUTH_RATE_LIMITED";
  }
  if (error instanceof SyncRunNotFoundError || hasCode(error, "SYNC_RUN_NOT_FOUND")) {
    return "SYNC_RUN_NOT_FOUND";
  }
  if (hasCode(error, "MAINTENANCE_RUN_NOT_FOUND")) {
    return "MAINTENANCE_RUN_NOT_FOUND";
  }
  return "INTERNAL_ERROR";
}

function isMalformedJsonError(error: unknown): boolean {
  return hasErrorCode(error, "FST_ERR_CTP_INVALID_JSON_BODY");
}

function isUnsupportedContentTypeError(error: unknown): boolean {
  return hasErrorCode(error, "FST_ERR_CTP_INVALID_MEDIA_TYPE");
}

function requestErrorMessage(error: unknown, code: ApiErrorCode): string {
  if (code === "INTERNAL_ERROR") return "Internal server error";
  if (isMalformedJsonError(error)) return "Malformed JSON request body";
  if (isUnsupportedContentTypeError(error)) return "Request body must be empty";
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Invalid request";
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === code
  );
}

function hasCode(
  error: unknown,
  code: Exclude<ApiErrorCode, "INVALID_REQUEST" | "INTERNAL_ERROR">,
): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === code
  );
}
