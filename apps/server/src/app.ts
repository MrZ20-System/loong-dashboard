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
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyServerOptions,
} from "fastify";
import { ZodError, type ZodType } from "zod";

import type { SyncCoordinator } from "./sync-coordinator.js";

const healthResponse: HealthResponse = healthResponseSchema.parse({
  status: "ok",
});

/** Explicit non-HTTP dependency set used by the app factory. */
export interface BuildAppDependencies {
  database: DatabaseClient;
  timezone: string;
  syncCoordinator: SyncCoordinator;
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
  const app = Fastify(options);

  app.get("/api/health", async (_request, reply) => {
    return reply.code(200).send(healthResponse);
  });

  registerStageOneRoutes(app, database, timezone, syncCoordinator);

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

function parseRequest<T>(schema: ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new InvalidRequestError(formatZodError(parsed.error));
  }
  return parsed.data;
}

function sendParsed<T>(
  reply: FastifyReply,
  statusCode: number,
  schema: ZodType<T>,
  value: unknown,
): FastifyReply {
  return reply.code(statusCode).send(schema.parse(value));
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

class InvalidRequestError extends Error {
  readonly code = "INVALID_REQUEST" as const;

  constructor(message: string) {
    super(message);
    this.name = "InvalidRequestError";
  }
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
        : code === "REPOSITORY_NOT_FOUND"
          ? 404
          : code === "SYNC_ALREADY_RUNNING"
            ? 409
            : 500;
  const message =
    code === "INTERNAL_ERROR"
      ? "Internal server error"
      : error instanceof Error && error.message.trim().length > 0
        ? error.message
        : "Internal server error";
  const body = apiErrorSchema.parse({ error: { code, message } });
  return { statusCode, body };
}

function errorCode(error: unknown): ApiErrorCode {
  if (error instanceof InvalidRequestError || error instanceof ZodError) {
    return "INVALID_REQUEST";
  }
  if (hasCode(error, "INVALID_CURSOR")) return "INVALID_CURSOR";
  if (hasCode(error, "REPOSITORY_NOT_FOUND")) return "REPOSITORY_NOT_FOUND";
  if (hasCode(error, "SYNC_ALREADY_RUNNING")) return "SYNC_ALREADY_RUNNING";
  return "INTERNAL_ERROR";
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

function formatZodError(error: ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => {
      const path = issue.path.length === 0 ? "request" : issue.path.join(".");
      return `${path} ${issue.message}`;
    })
    .join("; ");
}
