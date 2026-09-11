import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase, type DatabaseClient } from "@loongboard/database";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import {
  AuthService,
  resetAuthFile,
} from "../src/auth.js";
import { buildTestApp } from "../src/app.js";
import { createSyncCoordinatorStub } from "./support/sync-coordinator.js";

const fixtures: Array<{ root: string; database: DatabaseClient; app: FastifyInstance }> = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.app.close();
    if (fixture.database.open) fixture.database.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

const syncCoordinator = createSyncCoordinatorStub();

function fixture(): { root: string; database: DatabaseClient; app: FastifyInstance } {
  const root = mkdtempSync(join(tmpdir(), "loongboard-auth-"));
  const database = openDatabase(join(root, "state.sqlite3"));
  const app = buildTestApp({
    database,
    timezone: "UTC",
    syncCoordinator,
    auth: new AuthService({ statePath: join(root, ".loong"), environment: {} }),
  }, { logger: false });
  fixtures.push({ root, database, app });
  return { root, database, app };
}

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"] as string | string[] | undefined;
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) throw new Error("Missing session cookie");
  return value.split(";", 1)[0]!;
}

describe("local password lock", () => {
  it("keeps auth off by default and exposes only the minimal status", async () => {
    const { app } = fixture();
    const status = await app.inject({ method: "GET", url: "/api/auth/status" });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({ enabled: false, unlocked: true });

    const repositories = await app.inject({ method: "GET", url: "/api/repositories" });
    expect(repositories.statusCode).toBe(200);
    expect(await app.inject({ method: "GET", url: "/api/health" })).toMatchObject({ statusCode: 200 });
  });

  it("gates business APIs, issues strict cookies, rotates sessions, and supports logout/disable", async () => {
    const { app, root } = fixture();
    const statePath = join(root, ".loong");
    const enabled = await app.inject({
      method: "POST",
      url: "/api/auth/password",
      payload: { password: "correct horse" },
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toEqual({ enabled: true, unlocked: true });
    const firstCookie = cookieFrom(enabled);
    expect(enabled.headers["set-cookie"]?.toString()).toContain("HttpOnly");
    expect(enabled.headers["set-cookie"]?.toString()).toContain("SameSite=Strict");
    expect(enabled.headers["set-cookie"]?.toString()).toContain("Path=/");
    expect(enabled.headers["set-cookie"]?.toString()).not.toContain("Secure");
    expect(statSync(statePath).mode & 0o777).toBe(0o700);
    expect(statSync(join(statePath, "auth.json")).mode & 0o777).toBe(0o600);

    const locked = await app.inject({ method: "GET", url: "/api/repositories" });
    expect(locked.statusCode).toBe(401);
    expect(locked.body).not.toContain("correct horse");
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/repositories", headers: { cookie: firstCookie } })).statusCode).toBe(200);

    const wrong = await app.inject({
      method: "POST",
      url: "/api/auth/unlock",
      payload: { password: "wrong" },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.body).not.toContain("wrong");

    const changed = await app.inject({
      method: "POST",
      url: "/api/auth/password",
      headers: { cookie: firstCookie },
      payload: { password: "new secret" },
    });
    expect(changed.statusCode).toBe(200);
    const secondCookie = cookieFrom(changed);
    expect((await app.inject({ method: "GET", url: "/api/repositories", headers: { cookie: firstCookie } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/repositories", headers: { cookie: secondCookie } })).statusCode).toBe(200);

    const logout = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: secondCookie },
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.headers["set-cookie"]?.toString()).toMatch(/Max-Age=0/);

    const disabled = await app.inject({
      method: "POST",
      url: "/api/auth/disable",
      headers: { cookie: secondCookie },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toEqual({ enabled: false, unlocked: true });
    expect((await app.inject({ method: "GET", url: "/api/repositories" })).statusCode).toBe(200);
    expect(JSON.parse(readFileSync(join(statePath, "auth.json"), "utf8"))).not.toHaveProperty("password");
  });

  it("uses a short in-memory backoff and clears it after a successful unlock", async () => {
    const root = mkdtempSync(join(tmpdir(), "loongboard-auth-service-"));
    const now = { value: new Date("2026-09-11T00:00:00.000Z") };
    const service = new AuthService({ statePath: join(root, ".loong"), now: () => now.value, environment: {} });
    await service.setPassword("secret");
    await expect(service.unlock("bad")).rejects.toMatchObject({ code: "AUTH_INVALID_PASSWORD" });
    await expect(service.unlock("bad")).rejects.toMatchObject({ code: "AUTH_RATE_LIMITED" });
    const restarted = new AuthService({ statePath: join(root, ".loong"), now: () => now.value, environment: {} });
    await expect(restarted.unlock("bad")).rejects.toMatchObject({ code: "AUTH_INVALID_PASSWORD" });
    now.value = new Date("2026-09-11T00:00:05.000Z");
    await expect(service.unlock("secret")).resolves.toMatchObject({ status: { unlocked: true } });
    rmSync(root, { recursive: true, force: true });
  });

  it("resets exactly auth.json without touching neighboring data", () => {
    const root = mkdtempSync(join(tmpdir(), "loongboard-auth-reset-"));
    const statePath = join(root, ".loong");
    const sentinel = join(root, "knowledge.sqlite.sentinel");
    const service = new AuthService({ statePath, environment: {} });
    return service.setPassword("secret").then(() => {
      writeFileSync(sentinel, "keep", "utf8");
      chmodSync(sentinel, 0o600);
      expect(resetAuthFile(join(statePath, "auth.json"))).toBe(true);
      expect(() => readFileSync(join(statePath, "auth.json"))).toThrow();
      expect(readFileSync(sentinel, "utf8")).toBe("keep");
      rmSync(root, { recursive: true, force: true });
    });
  });
});
