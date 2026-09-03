import {
  createDomainRule,
  deleteDomainRule,
  getPullRequestFiles,
  listDomainRules,
  updateDomainRule,
  type DatabaseClient,
} from "@loongboard/database";
import {
  domainDeleteResponseSchema,
  domainMutationResponseSchema,
  domainParamsSchema,
  domainRuleCreateSchema,
  domainRuleUpdateSchema,
  domainsResponseSchema,
  pullRequestFilesResponseSchema,
  pullRequestParamsSchema,
  repositoryParamsSchema,
} from "@loongboard/contracts";
import type { FastifyInstance } from "fastify";

import type { DomainReclassification } from "./reclassification-service.js";
import { parseRequest, sendParsed } from "./route-helpers.js";

export interface DomainRoutesDependencies {
  database: DatabaseClient;
  reclassification: DomainReclassification;
}

/**
 * Domain rule CRUD and the stored changed-file read model (plan 17.3, 18.1).
 * Every successful mutation triggers the local serial reclassification run;
 * the response carries its snapshot so the web can show "重新分类中"
 * without polling a second endpoint.
 */
export function registerDomainRoutes(
  app: FastifyInstance,
  dependencies: DomainRoutesDependencies,
): void {
  const { database, reclassification } = dependencies;

  app.get("/api/repositories/:id/domains", async (request, reply) => {
    const { id } = parseRequest(repositoryParamsSchema, request.params);
    const items = listDomainRules(database, id);
    return sendParsed(reply, 200, domainsResponseSchema, {
      items,
      reclassification: reclassification.status(id),
    });
  });

  app.post("/api/repositories/:id/domains", async (request, reply) => {
    const { id } = parseRequest(repositoryParamsSchema, request.params);
    const body = parseRequest(domainRuleCreateSchema, request.body);
    const item = createDomainRule(database, id, {
      name: body.name,
      color: body.color,
      includePatterns: body.includePatterns,
      excludePatterns: body.excludePatterns,
      enabled: body.enabled,
    });
    return sendParsed(reply, 201, domainMutationResponseSchema, {
      item,
      reclassification: reclassification.trigger(id),
    });
  });

  app.put(
    "/api/repositories/:id/domains/:domainId",
    async (request, reply) => {
      const { id, domainId } = parseRequest(domainParamsSchema, request.params);
      const body = parseRequest(domainRuleUpdateSchema, request.body);
      const item = updateDomainRule(database, id, domainId, body);
      return sendParsed(reply, 200, domainMutationResponseSchema, {
        item,
        reclassification: reclassification.trigger(id),
      });
    },
  );

  app.delete(
    "/api/repositories/:id/domains/:domainId",
    async (request, reply) => {
      const { id, domainId } = parseRequest(domainParamsSchema, request.params);
      deleteDomainRule(database, id, domainId);
      return sendParsed(reply, 200, domainDeleteResponseSchema, {
        deleted: true,
        reclassification: reclassification.trigger(id),
      });
    },
  );

  app.get(
    "/api/repositories/:id/pulls/:number/files",
    async (request, reply) => {
      const { id, number } = parseRequest(
        pullRequestParamsSchema,
        request.params,
      );
      const stored = getPullRequestFiles(database, id, number);
      return sendParsed(reply, 200, pullRequestFilesResponseSchema, {
        repositoryId: id,
        number,
        headSha: stored.headSha,
        truncated: stored.truncated,
        items: stored.items,
      });
    },
  );
}
