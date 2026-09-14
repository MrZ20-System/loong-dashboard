import {
  personalDataImportResponseSchema,
  personalDataImportSchema,
  personalDataInstructionTreeRefreshResponseSchema,
  personalDataStatusSchema,
} from "@loongboard/contracts";
import type { FastifyInstance } from "fastify";

import { assertEmptyRequestBody, parseRequest, sendParsed } from "../route-helpers.js";
import type { PersonalDataService } from "../personal-data.js";

export interface PersonalDataRoutesDependencies {
  personalData: PersonalDataService;
  /** SettingsController owns this path in the composed application. */
  registerStatusRoute?: boolean;
}

/** Personal Data import and instruction-tree routes. */
export function registerPersonalDataRoutes(
  app: FastifyInstance,
  dependencies: PersonalDataRoutesDependencies,
): void {
  if (dependencies.registerStatusRoute !== false) {
    app.get("/api/settings/personal-data", async (_request, reply) => {
      return sendParsed(reply, 200, personalDataStatusSchema, dependencies.personalData.getStatus());
    });
  }

  app.post("/api/settings/personal-data/import", async (request, reply) => {
    const input = parseRequest(personalDataImportSchema, request.body);
    const result = await dependencies.personalData.importRepository(input);
    return sendParsed(reply, 200, personalDataImportResponseSchema, result);
  });

  app.post("/api/settings/personal-data/instruction-tree/refresh", async (request, reply) => {
    assertEmptyRequestBody(request.body);
    return sendParsed(
      reply,
      200,
      personalDataInstructionTreeRefreshResponseSchema,
      dependencies.personalData.refreshInstructionTree(),
    );
  });
}
