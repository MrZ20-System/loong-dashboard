import {
  assertEmptyRequestBody,
  parseRequest,
  sendParsed,
} from "../route-helpers.js";
import {
  repositoryOnboardingAcceptedSchema,
  repositoryOnboardingListResponseSchema,
  repositoryOnboardingParamsSchema,
  repositoryOnboardingRetrySchema,
  repositoryOnboardingSchema,
} from "@loongboard/contracts";
import type { FastifyInstance } from "fastify";

import type { RepositoryOnboardingService } from "../repository-onboarding.js";

export interface RepositoryOnboardingRoutesDependencies {
  onboarding: RepositoryOnboardingService;
}

/** Durable status and lifecycle controls for asynchronous repository onboarding. */
export function registerRepositoryOnboardingRoutes(
  app: FastifyInstance,
  dependencies: RepositoryOnboardingRoutesDependencies,
): void {
  app.get("/api/repository-onboarding", async (_request, reply) => {
    return sendParsed(
      reply,
      200,
      repositoryOnboardingListResponseSchema,
      { items: dependencies.onboarding.list() },
    );
  });

  app.get("/api/repository-onboarding/:jobId", async (request, reply) => {
    const { jobId } = parseRequest(repositoryOnboardingParamsSchema, request.params);
    return sendParsed(
      reply,
      200,
      repositoryOnboardingSchema,
      dependencies.onboarding.get(jobId),
    );
  });

  app.post("/api/repository-onboarding/:jobId/retry", async (request, reply) => {
    const { jobId } = parseRequest(repositoryOnboardingParamsSchema, request.params);
    const body = request.body === undefined ? {} : parseRequest(repositoryOnboardingRetrySchema, request.body);
    const job = dependencies.onboarding.retry(jobId, body);
    return sendParsed(
      reply,
      202,
      repositoryOnboardingAcceptedSchema,
      { jobId: job.jobId, status: "queued" },
    );
  });

  app.post("/api/repository-onboarding/:jobId/cancel", async (request, reply) => {
    assertEmptyRequestBody(request.body);
    const { jobId } = parseRequest(repositoryOnboardingParamsSchema, request.params);
    return sendParsed(
      reply,
      200,
      repositoryOnboardingSchema,
      dependencies.onboarding.cancel(jobId),
    );
  });
}
