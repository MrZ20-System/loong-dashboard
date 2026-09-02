import {
  healthResponseSchema,
  type HealthResponse,
} from "@loongboard/contracts";
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";

const healthResponse: HealthResponse = healthResponseSchema.parse({
  status: "ok",
});

export function buildApp(
  options: FastifyServerOptions = {},
): FastifyInstance {
  const app = Fastify(options);

  app.get("/api/health", async (_request, reply) => {
    return reply.code(200).send(healthResponse);
  });

  return app;
}
