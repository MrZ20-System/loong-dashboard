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

    expect(dockerfile).toContain("FROM node:24-bookworm-slim AS build");
    expect(dockerfile).toContain("FROM node:24-bookworm-slim AS runtime");
    expect(dockerfile).toContain("corepack prepare pnpm@11.19.0 --activate");
    expect(dockerfile).toContain("pnpm install --frozen-lockfile");
    expect(dockerfile).toContain("RUN pnpm build");
    expect(dockerfile).toContain('CMD ["pnpm", "start"]');
    expect(dockerfile).not.toMatch(/COPY[^\n]*\b(?:system\.yaml|knowledge|\.loong|\.worktrees)\b/);

    for (const entry of ["node_modules", "dist", ".git", ".loong", ".worktrees", "/knowledge", "/system.yaml"]) {
      expect(dockerignore).toContain(entry);
    }
  });

  it("binds one persistent data root and localhost port in compose", async () => {
    const compose = parseYaml(await readRepositoryFile("compose.yaml")) as {
      services?: {
        loongboard?: {
          restart?: string;
          ports?: string[];
          environment?: Record<string, string | number>;
          volumes?: string[];
        };
      };
    };
    const service = compose.services?.loongboard;

    expect(service).toBeDefined();
    expect(service?.restart).toBe("unless-stopped");
    expect(service?.ports).toContain("127.0.0.1:4174:4174");
    expect(service?.volumes).toContain("${LOONGBOARD_DATA_DIR:-./loongboard-data}:/data");
    expect(service?.environment).toMatchObject({
      LOONGBOARD_SYSTEM_CONFIG: "/data/system.yaml",
      LOONGBOARD_SERVER_HOST: "0.0.0.0",
      LOONGBOARD_SERVER_PORT: 4174,
    });
  });
});
