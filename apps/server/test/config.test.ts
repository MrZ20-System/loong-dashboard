import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  loadSystemConfig,
  parseSystemConfig,
  resolveSystemConfigPath,
} from "../src/config.js";

const fixtureDirectory = fileURLToPath(new URL("fixtures", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const serverPackageDirectory = resolve(repositoryRoot, "apps/server");

function validConfigInput() {
  return {
    version: 1 as const,
    timezone: "Asia/Shanghai",
    repositories: [
      {
        key: "loongboard",
        name: "LoongBoard",
        github: "MrZ20/loong-dashboard",
        path: "./loong-dashboard",
        remote: "origin",
        defaultBranch: "main",
        worktreeSlots: 2,
      },
    ],
    knowledge: {
      path: "./knowledge",
      inbox: "inbox",
      historyLimit: 10,
    },
    runtime: {
      statePath: "./.loong",
      worktreesPath: "./.worktrees",
      serverHost: "127.0.0.1",
      serverPort: 4174,
    },
    agent: {
      defaultProvider: "deepseek-official",
      defaultModel: "deepseek-v4-flash",
      defaultReasoningEffort: "high",
      idleProcessMinutes: 20,
    },
  };
}

describe("system configuration", () => {
  it("loads the complete V1 system.yaml contract", () => {
    const config = loadSystemConfig(
      resolve(fixtureDirectory, "valid-system.yaml"),
    );

    expect(config).toMatchObject({
      version: 1,
      timezone: "Asia/Shanghai",
      knowledge: {
        inbox: resolve(fixtureDirectory, "knowledge/inbox"),
        historyLimit: 10,
      },
      runtime: { serverHost: "127.0.0.1", serverPort: 4174 },
      agent: {
        defaultProvider: "deepseek-official",
        defaultModel: "deepseek-v4-flash",
        defaultReasoningEffort: "high",
        idleProcessMinutes: 20,
      },
    });
  });

  it("fails fast when a required value is invalid", () => {
    const configPath = resolve(fixtureDirectory, "invalid-system.yaml");

    expect(() => loadSystemConfig(configPath)).toThrowError(
      new RegExp(`Invalid system configuration at ${configPath}`),
    );
  });

  it.each<{ layer: string; input: () => unknown }>([
    {
      layer: "root",
      input: () => ({ ...validConfigInput(), unexpected: true }),
    },
    {
      layer: "repository",
      input: () => {
        const config = validConfigInput();
        return {
          ...config,
          repositories: [{ ...config.repositories[0], unexpected: true }],
        };
      },
    },
    {
      layer: "knowledge",
      input: () => {
        const config = validConfigInput();
        return {
          ...config,
          knowledge: { ...config.knowledge, unexpected: true },
        };
      },
    },
    {
      layer: "runtime",
      input: () => {
        const config = validConfigInput();
        return {
          ...config,
          runtime: { ...config.runtime, unexpected: true },
        };
      },
    },
    {
      layer: "agent",
      input: () => {
        const config = validConfigInput();
        return {
          ...config,
          agent: { ...config.agent, unexpected: true },
        };
      },
    },
  ])("rejects an extra field at the $layer layer", ({ input }) => {
    expect(() =>
      parseSystemConfig(input(), "/workspace/system.yaml"),
    ).toThrowError(/Invalid system configuration/);
  });

  it("resolves every configured path relative to the system.yaml directory", () => {
    const configPath = resolve(fixtureDirectory, "valid-system.yaml");
    const config = loadSystemConfig(configPath);
    const configDirectory = dirname(configPath);

    expect(config.repositories.map((repository) => repository.path)).toEqual([
      resolve(configDirectory, "repositories/loongboard"),
      "/absolute/vllm",
    ]);
    expect(config.knowledge.path).toBe(resolve(configDirectory, "knowledge"));
    expect(config.knowledge.inbox).toBe(
      resolve(configDirectory, "knowledge/inbox"),
    );
    expect(config.runtime.statePath).toBe(resolve(configDirectory, ".loong"));
    expect(config.runtime.worktreesPath).toBe(
      resolve(configDirectory, ".worktrees"),
    );
  });

  it.each([
    ["absolute", "/outside/inbox"],
    ["parent traversal", "../outside"],
  ])("rejects an %s knowledge inbox", (_label, inbox) => {
    const config = validConfigInput();

    expect(() =>
      parseSystemConfig(
        {
          ...config,
          knowledge: { ...config.knowledge, inbox },
        },
        resolve(repositoryRoot, "system.yaml"),
      ),
    ).toThrowError(/knowledge\.inbox/);
  });

  it("resolves the default from the repository root cwd", () => {
    expect(resolveSystemConfigPath({}, repositoryRoot)).toBe(
      resolve(repositoryRoot, "..", "system.yaml"),
    );
  });

  it("resolves the same default from the real apps/server cwd", () => {
    expect(resolveSystemConfigPath({}, serverPackageDirectory)).toBe(
      resolve(repositoryRoot, "..", "system.yaml"),
    );
  });

  it("keeps LOONGBOARD_SYSTEM_CONFIG as the single root-relative override", () => {
    expect(
      resolveSystemConfigPath(
        { LOONGBOARD_SYSTEM_CONFIG: "config/custom.yaml" },
        serverPackageDirectory,
      ),
    ).toBe(resolve(repositoryRoot, "config/custom.yaml"));
  });
});
