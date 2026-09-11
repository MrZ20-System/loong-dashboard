import {
  archivePreviewRequestSchema,
  archivePreviewResponseSchema,
  archiveRunCreateSchema,
  maintenanceRunAcceptedSchema,
  maintenanceRunParamsSchema,
  maintenanceRunSchema,
  maintenanceRunsResponseSchema,
  pullRequestParamsSchema,
  repositoryParamsSchema,
  restoreMetadataResponseSchema,
} from "@loongboard/contracts";
import type { FastifyInstance } from "fastify";

import {
  assertEmptyRequestBody,
  parseRequest,
  sendParsed,
} from "./route-helpers.js";
import { MetadataMaintenanceService } from "./metadata-maintenance.js";

export class MetadataMaintenanceRunNotFoundError extends Error {
  readonly code = "MAINTENANCE_RUN_NOT_FOUND" as const;

  constructor(runId: string) {
    super(`Maintenance run not found: ${runId}`);
    this.name = "MetadataMaintenanceRunNotFoundError";
  }
}

export interface MetadataMaintenanceRoutesDependencies {
  service: MetadataMaintenanceService;
}

/** Repository-scoped archive preview/run/status and entity restore routes. */
export function registerMetadataMaintenanceRoutes(
  app: FastifyInstance,
  dependencies: MetadataMaintenanceRoutesDependencies,
): void {
  const { service } = dependencies;

  app.post("/api/repositories/:id/maintenance/preview", async (request, reply) => {
    const { id } = parseRequest(repositoryParamsSchema, request.params);
    const body = parseRequest(archivePreviewRequestSchema, request.body);
    return sendParsed(reply, 200, archivePreviewResponseSchema, service.preview(id, body));
  });

  app.post("/api/repositories/:id/maintenance", async (request, reply) => {
    const { id } = parseRequest(repositoryParamsSchema, request.params);
    const body = parseRequest(archiveRunCreateSchema, request.body);
    const { run } = service.start(id, body, "manual");
    return sendParsed(reply, 202, maintenanceRunAcceptedSchema, {
      repositoryId: id,
      runId: run.id,
      status: "accepted",
    });
  });

  app.get("/api/repositories/:id/maintenance", async (request, reply) => {
    const { id } = parseRequest(repositoryParamsSchema, request.params);
    return sendParsed(reply, 200, maintenanceRunsResponseSchema, {
      items: service.list(id),
    });
  });

  app.get("/api/repositories/:repositoryId/maintenance/:runId", async (request, reply) => {
    const { repositoryId, runId } = parseRequest(maintenanceRunParamsSchema, request.params);
    const run = service.get(runId);
    if (run.repositoryId !== repositoryId) throw new MetadataMaintenanceRunNotFoundError(runId);
    return sendParsed(reply, 200, maintenanceRunSchema, run);
  });

  app.post("/api/repositories/:id/pulls/:number/restore", async (request, reply) => {
    assertEmptyRequestBody(request.body);
    const { id, number } = parseRequest(pullRequestParamsSchema, request.params);
    return sendParsed(
      reply,
      200,
      restoreMetadataResponseSchema,
      service.restorePullRequest(id, number),
    );
  });

  app.post("/api/repositories/:id/issues/:number/restore", async (request, reply) => {
    assertEmptyRequestBody(request.body);
    const { id, number } = parseRequest(pullRequestParamsSchema, request.params);
    return sendParsed(
      reply,
      200,
      restoreMetadataResponseSchema,
      service.restoreIssue(id, number),
    );
  });
}
