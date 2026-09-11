import {
  getIssueActivityDays,
  getPullRequestActivityDays,
  listIssues,
  listMergedPullRequests,
  listPullRequests,
  type DatabaseClient,
} from "@loongboard/database";
import {
  activityDaysQuerySchema,
  activityDaysResponseSchema,
  issueDetailSchema,
  issueParamsSchema,
  issuesQuerySchema,
  issuesResponseSchema,
  mergedPullRequestsQuerySchema,
  mergedPullRequestsResponseSchema,
  pullRequestsQuerySchema,
  pullRequestsResponseSchema,
  repositoryParamsSchema,
} from "@loongboard/contracts";
import type { FastifyInstance } from "fastify";

import { IssueDetailService } from "../issue-detail-service.js";
import { parseRequest, sendParsed } from "../route-helpers.js";

export interface MetadataRoutesDependencies {
  database: DatabaseClient;
  calendarTimeZone: string;
  issueDetails: IssueDetailService;
}

/** Route-level 404 for issue reads (stored metadata is SQLite-only). */
export class IssueNotFoundError extends Error {
  readonly code = "ISSUE_NOT_FOUND" as const;

  constructor(repositoryId: string, number: number) {
    super(`Issue #${number} was not found in repository ${repositoryId}`);
    this.name = "IssueNotFoundError";
  }
}

/** Read-only repository metadata projections and lazy issue detail refresh. */
export function registerMetadataRoutes(
  app: FastifyInstance,
  dependencies: MetadataRoutesDependencies,
): void {
  const { database, calendarTimeZone, issueDetails } = dependencies;

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
