import {
  assertEmptyRequestBody,
  parseRequest,
  sendParsed,
} from "../route-helpers.js";
import {
  authPasswordUpdateSchema,
  authStatusSchema,
  authUnlockRequestSchema,
} from "@loongboard/contracts";
import type { FastifyInstance } from "fastify";

import {
  AuthRateLimitedError,
  AuthService,
} from "../auth.js";

/** Auth endpoints and the unauthenticated API allow-list. */
export function registerAuthRoutes(app: FastifyInstance, auth: AuthService): void {
  app.get("/api/auth/status", async (request, reply) => {
    return sendParsed(reply, 200, authStatusSchema, auth.status(request.headers.cookie));
  });

  app.post("/api/auth/unlock", async (request, reply) => {
    const { password } = parseRequest(authUnlockRequestSchema, request.body);
    try {
      const result = await auth.unlock(password);
      if (result.token !== null) {
        reply.header("Set-Cookie", auth.sessionCookie(result.token, request.protocol === "https"));
      }
      return sendParsed(reply, 200, authStatusSchema, result.status);
    } catch (error: unknown) {
      if (error instanceof AuthRateLimitedError) {
        reply.header("Retry-After", String(error.retryAfterSeconds));
      }
      throw error;
    }
  });

  app.post("/api/auth/password", async (request, reply) => {
    const { password, currentPassword } = parseRequest(authPasswordUpdateSchema, request.body);
    try {
      const result = await auth.setPassword(password, request.headers.cookie, currentPassword);
      if (result.token !== null) {
        reply.header("Set-Cookie", auth.sessionCookie(result.token, request.protocol === "https"));
      }
      return sendParsed(reply, 200, authStatusSchema, result.status);
    } catch (error: unknown) {
      if (error instanceof AuthRateLimitedError) {
        reply.header("Retry-After", String(error.retryAfterSeconds));
      }
      throw error;
    }
  });

  app.post("/api/auth/disable", async (request, reply) => {
    const result = await auth.disable(request.headers.cookie);
    reply.header("Set-Cookie", auth.clearSessionCookie(request.protocol === "https"));
    return sendParsed(reply, 200, authStatusSchema, result.status);
  });

  // Logout is intentionally idempotent and public: clearing an old cookie is
  // safe even after the password has been rotated or reset locally.
  app.post("/api/auth/logout", async (request, reply) => {
    assertEmptyRequestBody(request.body);
    reply.header("Set-Cookie", auth.clearSessionCookie(request.protocol === "https"));
    return sendParsed(reply, 200, authStatusSchema, auth.status());
  });
}

export function isPublicApiPath(pathname: string): boolean {
  return pathname === "/api/health" ||
    pathname === "/api/health/live" ||
    pathname === "/api/auth/status" ||
    pathname === "/api/auth/unlock";
}
