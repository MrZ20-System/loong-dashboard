import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

async function readRepositoryFile(name: string): Promise<string> {
  return readFile(resolve(repositoryRoot, name), "utf8");
}

describe("Docker deployment files", () => {
  it("keeps the production image and data boundary explicit", async () => {
    const dockerfile = await readRepositoryFile("Dockerfile");
    const dockerignore = await readRepositoryFile(".dockerignore");
    const packageJson = JSON.parse(await readRepositoryFile("package.json")) as {
      scripts?: Record<string, string>;
    };

    expect(dockerfile).toContain("FROM node:24-bookworm-slim AS build");
    expect(dockerfile).toContain("FROM node:24-bookworm-slim AS runtime");
    expect(dockerfile).toContain("corepack prepare pnpm@11.19.0 --activate");
    expect(dockerfile).toContain("pnpm install --frozen-lockfile");
    expect(dockerfile).toContain("RUN pnpm build");
    expect(dockerfile).toContain('CMD ["pnpm", "start"]');
    expect(packageJson.scripts?.["auth:reset"]).toBe(
      "node --conditions=production apps/server/dist/auth-reset.js",
    );
    expect(dockerfile).not.toMatch(/COPY[^\n]*\b(?:system\.yaml|knowledge|\.loong|\.worktrees)\b/);

    for (const entry of [
      "node_modules",
      "dist",
      ".git",
      ".loong",
      ".worktrees",
      "/knowledge",
      "/system.yaml",
      "auth.json",
      "github-credential.json",
      "provider-secrets",
    ]) {
      expect(dockerignore).toContain(entry);
    }
  });

  it("binds one persistent data root and directly published port in compose", async () => {
    const compose = parseYaml(await readRepositoryFile("compose.yaml")) as {
      services?: {
        loongboard?: {
          image?: string;
          restart?: string;
          ports?: string[];
          environment?: Record<string, string | number>;
          volumes?: string[];
          healthcheck?: {
            test?: string[];
            interval?: string;
            timeout?: string;
            retries?: number;
            start_period?: string;
          };
        };
      };
    };
    const service = compose.services?.loongboard;

    expect(service).toBeDefined();
    expect(service?.image).toBe("${LOONGBOARD_IMAGE:-quay.io/lonng/dashboard:v0.1.0rc1}");
    expect(service?.restart).toBe("unless-stopped");
    expect(service?.ports).toContain("4174:4174");
    expect(service?.volumes).toContain("${LOONGBOARD_DATA_DIR:-./loongboard-data}:/data");
    expect(service?.environment).toMatchObject({
      LOONGBOARD_SYSTEM_CONFIG: "/data/system.yaml",
      LOONGBOARD_SERVER_HOST: "0.0.0.0",
      LOONGBOARD_SERVER_PORT: 4174,
    });
    expect(service?.healthcheck).toMatchObject({
      test: expect.arrayContaining(["CMD", "node"]),
      interval: "30s",
      timeout: "5s",
      retries: 3,
      start_period: "10s",
    });
    expect(service?.healthcheck?.test?.join(" ")).toContain("/api/health/live");
    expect(service?.healthcheck?.test?.join(" ")).not.toMatch(/curl|wget/);
  });
});
