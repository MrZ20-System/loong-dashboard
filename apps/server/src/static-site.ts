import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

/**
 * Register the production React artifact without making app factory tests
 * depend on a web build being present.
 */
export function registerProductionStaticSite(
  app: FastifyInstance,
  staticRoot: string,
): void {
  const root = resolve(staticRoot);
  const indexPath = resolve(root, "index.html");
  if (!existsSync(indexPath) || !statSync(indexPath).isFile()) {
    throw new Error(`Production web artifact is missing: ${indexPath}`);
  }

  // Disable the plugin's wildcard route so that the explicit fallback below
  // can distinguish client-side routes from unknown API routes.
  app.register(fastifyStatic, {
    root,
    prefix: "/",
    wildcard: false,
  });

  app.get("/*", async (request, reply) => {
    const pathname = request.url.split("?", 1)[0] ?? request.url;
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      reply.callNotFound();
      return;
    }
    return reply.sendFile("index.html");
  });
}
