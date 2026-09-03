import {
  getIssueActivityDays,
  getPullRequestActivityDays,
  getRepositorySyncStatus,
  listIssues,
  listPullRequests,
  listRepositories,
  type DatabaseClient,
} from "@loongboard/database";
import {
  activityDaysQuerySchema,
  activityDaysResponseSchema,
  apiErrorSchema,
  healthResponseSchema,
  issuesQuerySchema,
  issuesResponseSchema,
  pullRequestsQuerySchema,
  pullRequestsResponseSchema,
  repositoriesResponseSchema,
  repositoryParamsSchema,
  syncAcceptedResponseSchema,
  syncStatusResponseSchema,
  type ApiErrorCode,
  type HealthResponse,
} from "@loongboard/contracts";
import {
  LocalGitWorkspace,
  type GitWorkspace,
} from "@loongboard/git-workspace";
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";

import { registerDomainRoutes } from "./domains.js";
import { registerDiffRoutes } from "./diff.js";
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

const healthResponse: HealthResponse = healthResponseSchema.parse({
  status: "ok",
});

/** Explicit non-HTTP dependency set used by the app factory. */
export interface BuildAppDependencies {
  database: DatabaseClient;
  timezone: string;
  syncCoordinator: SyncCoordinator;
  /** Defaults to an in-process serial service owned by the app. */
  reclassification?: DomainReclassification;
  /** Defaults to a real local Git workspace. */
  gitWorkspace?: GitWorkspace;
}

/**
 * Build the local HTTP app without opening a socket. Dependencies are passed
 * as one explicit shape so route composition cannot accidentally construct a
 * partially wired application.
 */
export function buildApp(
  dependencies: BuildAppDependencies,
  options: FastifyServerOptions = {},
): FastifyInstance {
  const { database, timezone, syncCoordinator } = dependencies;
  const ownsReclassification = dependencies.reclassification === undefined;
  const reclassification =
    dependencies.reclassification ??
    new DomainReclassificationService({ database });
  const gitWorkspace = dependencies.gitWorkspace ?? new LocalGitWorkspace();
  const app = Fastify(options);
  configureJsonParser(app);

  app.get("/api/health", async (_request, reply) => {
    return reply.code(200).send(healthResponse);
  });

  registerStageOneRoutes(app, database, timezone, syncCoordinator);
  registerDomainRoutes(app, { database, reclassification });
  registerDiffRoutes(app, { database, gitWorkspace });

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
    }));
    return sendParsed(reply, 200, repositoriesResponseSchema, {
      items: repositories,
    });
  });

  app.post("/api/repositories/:id/sync", async (request, reply) => {
    assertEmptyRequestBody(request.body);
    const { id } = parseRequest(repositoryParamsSchema, request.params);
    const run = syncCoordinator.start(id);
    return sendParsed(reply, 202, syncAcceptedResponseSchema, {
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
      date: query.date,
      status: query.status,
      cursor: query.cursor,
      domainIds: query.domain,
    });
    return sendParsed(reply, 200, pullRequestsResponseSchema, page);
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
      date: query.date,
      status: query.status,
      cursor: query.cursor,
    });
    return sendParsed(reply, 200, issuesResponseSchema, page);
  });
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
            code === "PULL_REQUEST_NOT_FOUND" ||
            code === "FILE_NOT_FOUND"
          ? 404
          : code === "SYNC_ALREADY_RUNNING" || code === "DOMAIN_NAME_CONFLICT"
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
  if (hasCode(error, "DOMAIN_NAME_CONFLICT")) return "DOMAIN_NAME_CONFLICT";
  if (hasCode(error, "PULL_REQUEST_NOT_FOUND")) {
    return "PULL_REQUEST_NOT_FOUND";
  }
  if (hasCode(error, "FILE_NOT_FOUND")) return "FILE_NOT_FOUND";
  if (hasCode(error, "SYNC_ALREADY_RUNNING")) return "SYNC_ALREADY_RUNNING";
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
