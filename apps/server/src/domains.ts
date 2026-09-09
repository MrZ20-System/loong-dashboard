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
  jsonSourceSchema,
  jsonSourceUpdateSchema,
  jsonSourceVersionDetailSchema,
  jsonSourceVersionParamsSchema,
  jsonSourceVersionsResponseSchema,
  pullRequestFilesResponseSchema,
  pullRequestParamsSchema,
  repositoryParamsSchema,
} from "@loongboard/contracts";
import type { FastifyInstance } from "fastify";

import type { DomainFileService } from "./domain-file.js";
import type { DomainReclassification } from "./reclassification-service.js";
import { assertEmptyRequestBody, parseRequest, sendParsed } from "./route-helpers.js";

export interface DomainRoutesDependencies {
  database: DatabaseClient;
  reclassification: DomainReclassification;
  /** File source of truth. Omitted only for legacy/unit-test app fixtures. */
  domainFiles?: DomainFileService;
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
  const { database, reclassification, domainFiles } = dependencies;

  app.get("/api/repositories/:id/domains", async (request, reply) => {
    const { id } = parseRequest(repositoryParamsSchema, request.params);
    const refreshed = domainFiles?.refresh(id);
    const items = listDomainRules(database, id);
    return sendParsed(reply, 200, domainsResponseSchema, {
      items,
      reclassification: reclassification.status(id),
      sourceError: refreshed?.source.parseError ?? null,
    });
  });

  app.post("/api/repositories/:id/domains", async (request, reply) => {
    const { id } = parseRequest(repositoryParamsSchema, request.params);
    const body = parseRequest(domainRuleCreateSchema, request.body);
    const item = domainFiles
      ? domainFiles.create(id, body)
      : createDomainRule(database, id, {
          name: body.name,
          color: body.color,
          includePatterns: body.includePatterns,
          excludePatterns: body.excludePatterns,
          enabled: body.enabled,
        });
    return sendParsed(reply, 201, domainMutationResponseSchema, {
      item,
      reclassification: domainFiles
        ? reclassification.status(id)
        : reclassification.trigger(id),
    });
  });

  app.put(
    "/api/repositories/:id/domains/:domainId",
    async (request, reply) => {
      const { id, domainId } = parseRequest(domainParamsSchema, request.params);
      const body = parseRequest(domainRuleUpdateSchema, request.body);
      const item = domainFiles
        ? domainFiles.update(id, domainId, body)
        : updateDomainRule(database, id, domainId, body);
      return sendParsed(reply, 200, domainMutationResponseSchema, {
        item,
        reclassification: domainFiles
          ? reclassification.status(id)
          : reclassification.trigger(id),
      });
    },
  );

  app.delete(
    "/api/repositories/:id/domains/:domainId",
    async (request, reply) => {
      const { id, domainId } = parseRequest(domainParamsSchema, request.params);
      if (domainFiles) domainFiles.remove(id, domainId);
      else deleteDomainRule(database, id, domainId);
      return sendParsed(reply, 200, domainDeleteResponseSchema, {
        deleted: true,
        reclassification: domainFiles
          ? reclassification.status(id)
          : reclassification.trigger(id),
      });
    },
  );

  app.get(
    "/api/repositories/:id/domains/source",
    async (request, reply) => {
      const { id } = parseRequest(repositoryParamsSchema, request.params);
      if (domainFiles === undefined) {
        throw new Error("Domain file service is not configured");
      }
      return sendParsed(reply, 200, jsonSourceSchema, domainFiles.source(id));
    },
  );

  app.put(
    "/api/repositories/:id/domains/source",
    async (request, reply) => {
      const { id } = parseRequest(repositoryParamsSchema, request.params);
      const body = parseRequest(jsonSourceUpdateSchema, request.body);
      if (domainFiles === undefined) {
        throw new Error("Domain file service is not configured");
      }
      return sendParsed(
        reply,
        200,
        jsonSourceSchema,
        domainFiles.saveSource(id, body.content),
      );
    },
  );

  app.get(
    "/api/repositories/:id/domains/source/versions",
    async (request, reply) => {
      const { id } = parseRequest(repositoryParamsSchema, request.params);
      if (domainFiles === undefined) {
        throw new Error("Domain file service is not configured");
      }
      return sendParsed(reply, 200, jsonSourceVersionsResponseSchema, {
        items: domainFiles.listVersions("domain", id),
      });
    },
  );

  app.get(
    "/api/repositories/:id/domains/source/versions/:versionId",
    async (request, reply) => {
      const { id, versionId } = parseRequest(
        jsonSourceVersionParamsSchema,
        request.params,
      );
      if (domainFiles === undefined) {
        throw new Error("Domain file service is not configured");
      }
      return sendParsed(
        reply,
        200,
        jsonSourceVersionDetailSchema,
        domainFiles.version("domain", id, versionId),
      );
    },
  );

  app.post(
    "/api/repositories/:id/domains/source/versions/:versionId/restore",
    async (request, reply) => {
      const { id, versionId } = parseRequest(
        jsonSourceVersionParamsSchema,
        request.params,
      );
      assertEmptyRequestBody(request.body);
      if (domainFiles === undefined) {
        throw new Error("Domain file service is not configured");
      }
      return sendParsed(
        reply,
        200,
        jsonSourceSchema,
        domainFiles.restoreSource(id, versionId),
      );
    },
  );

  app.get(
    "/api/repositories/:id/domains/prompt",
    async (request, reply) => {
      const { id } = parseRequest(repositoryParamsSchema, request.params);
      // Validate the repository even though the shared prompt has one file.
      if (domainFiles === undefined) {
        throw new Error("Domain file service is not configured");
      }
      listDomainRules(database, id);
      return sendParsed(reply, 200, jsonSourceSchema, domainFiles.prompt());
    },
  );

  app.put(
    "/api/repositories/:id/domains/prompt",
    async (request, reply) => {
      const { id } = parseRequest(repositoryParamsSchema, request.params);
      const body = parseRequest(jsonSourceUpdateSchema, request.body);
      if (domainFiles === undefined) {
        throw new Error("Domain file service is not configured");
      }
      listDomainRules(database, id);
      return sendParsed(
        reply,
        200,
        jsonSourceSchema,
        domainFiles.savePrompt(body.content),
      );
    },
  );

  app.get(
    "/api/repositories/:id/domains/prompt/versions",
    async (request, reply) => {
      const { id } = parseRequest(repositoryParamsSchema, request.params);
      if (domainFiles === undefined) {
        throw new Error("Domain file service is not configured");
      }
      listDomainRules(database, id);
      return sendParsed(reply, 200, jsonSourceVersionsResponseSchema, {
        items: domainFiles.listVersions("prompt", id),
      });
    },
  );

  app.get(
    "/api/repositories/:id/domains/prompt/versions/:versionId",
    async (request, reply) => {
      const { id, versionId } = parseRequest(
        jsonSourceVersionParamsSchema,
        request.params,
      );
      if (domainFiles === undefined) {
        throw new Error("Domain file service is not configured");
      }
      listDomainRules(database, id);
      return sendParsed(
        reply,
        200,
        jsonSourceVersionDetailSchema,
        domainFiles.version("prompt", id, versionId),
      );
    },
  );

  app.post(
    "/api/repositories/:id/domains/prompt/versions/:versionId/restore",
    async (request, reply) => {
      const { id, versionId } = parseRequest(
        jsonSourceVersionParamsSchema,
        request.params,
      );
      assertEmptyRequestBody(request.body);
      if (domainFiles === undefined) {
        throw new Error("Domain file service is not configured");
      }
      listDomainRules(database, id);
      return sendParsed(
        reply,
        200,
        jsonSourceSchema,
        domainFiles.restorePrompt(versionId),
      );
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
