import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("GET /api/health", () => {
  it("returns the exact shared health response", async () => {
    const app = buildApp();
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(
      /^application\/json(?:;\s*charset=utf-8)?$/,
    );
    expect(response.body).toBe('{"status":"ok"}');
    expect(response.json()).toEqual({ status: "ok" });
  });
});
