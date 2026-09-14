import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { describe, expect, it } from "vitest";

import {
  loadSystemConfig,
  migrateSystemConfigV1ToV2,
  parseSystemConfig,
  resolveSystemConfigPath,
} from "../src/config.js";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const serverPackageDirectory = resolve(repositoryRoot, "apps/server");

function validConfigInput() {
  return {
    version: 2 as const,
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
      checkpoint: {
        autoCommit: false,
        autoPush: false,
        remote: "origin",
        sourceRef: "main",
        remoteBranch: "loongboard-knowledge-backup",
        checkpointCron: "0 0 * * *",
        pushCron: "0 0 * * *",
      },
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

function validV1ConfigInput() {
  const { version: _version, knowledge, ...rest } = validConfigInput();
  const { checkpoint: _checkpoint, ...legacyKnowledge } = knowledge;
  return {
    ...rest,
    version: 1 as const,
    knowledge: {
      ...legacyKnowledge,
      checkpoint: {
        autoCommit: true,
        autoPush: false,
        remote: "origin",
        sourceRef: "main",
        remoteBranch: "loongboard-knowledge-backup",
        checkpointIntervalMinutes: 60,
        pushIntervalMinutes: null,
      },
    },
  };
}

describe("system configuration", () => {
  it("parses the complete V2 contract and defaults idle retention", () => {
    const input = validConfigInput();
    const { idleProcessMinutes: _idle, ...agent } = input.agent;
    expect(parseSystemConfig({ ...input, agent }, "/workspace/system.yaml").agent.idleProcessMinutes).toBe(120);
    expect(parseSystemConfig(input, "/workspace/system.yaml").version).toBe(2);
    expect(parseSystemConfig(input, "/workspace/system.yaml").knowledge.checkpoint?.checkpointCron).toBe("0 0 * * *");
  });

  it("migrates V1 schedules to V2, preserves topology, and atomically backs up the source", () => {
    const root = mkdtempSync(join(tmpdir(), "loongboard-config-migration-"));
    try {
      const configPath = join(root, "system.yaml");
      const legacy = validV1ConfigInput();
      writeFileSync(configPath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");
      const migrated = migrateSystemConfigV1ToV2(legacy) as Record<string, any>;
      expect(migrated.version).toBe(2);
      expect(migrated.knowledge.checkpoint).toMatchObject({
        checkpointCron: "0 */1 * * *",
        pushCron: "0 0 * * *",
      });

      const config = loadSystemConfig(configPath);
      expect(config.version).toBe(2);
      expect(config.repositories[0]?.github).toBe("MrZ20/loong-dashboard");
      expect(config.knowledge.path).toBe(resolve(root, "knowledge"));
      expect(config.knowledge.checkpoint?.checkpointCron).toBe("0 */1 * * *");
      expect(config.knowledge.checkpoint?.pushCron).toBe("0 0 * * *");
      expect(existsSync(`${configPath}.v1.bak`)).toBe(true);
      expect(JSON.parse(readFileSync(`${configPath}.v1.bak`, "utf8")).version).toBe(1);
      expect(parseYaml(readFileSync(configPath, "utf8")).version).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves a V1 source untouched when the migrated V2 config fails validation", () => {
    const root = mkdtempSync(join(tmpdir(), "loongboard-config-migration-failure-"));
    try {
      const configPath = join(root, "system.yaml");
      const legacy = {
        ...validV1ConfigInput(),
        timezone: "Mars/Olympus",
      };
      const original = `${JSON.stringify(legacy, null, 2)}\n`;
      writeFileSync(configPath, original, "utf8");

      expect(() => loadSystemConfig(configPath)).toThrowError(/valid IANA timezone/);
      expect(readFileSync(configPath, "utf8")).toBe(original);
      expect(existsSync(`${configPath}.v1.bak`)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses valid daily defaults for disabled V1 null checkpoint cadence", () => {
    const input = validV1ConfigInput();
    const migrated = migrateSystemConfigV1ToV2({
      ...input,
      knowledge: {
        ...input.knowledge,
        checkpoint: {
          ...input.knowledge.checkpoint,
          checkpointIntervalMinutes: null,
          pushIntervalMinutes: null,
        },
      },
    }) as any;
    expect(migrated.knowledge.checkpoint).toMatchObject({
      checkpointCron: "0 0 * * *",
      pushCron: "0 0 * * *",
    });
  });

  it("accepts only canonical V2 checkpoint Cron fields", () => {
    const input = validConfigInput();
    expect(parseSystemConfig(input, "/workspace/system.yaml").knowledge.checkpoint).toMatchObject({
      checkpointCron: "0 0 * * *",
      pushCron: "0 0 * * *",
    });
    expect(() => parseSystemConfig({
      ...input,
      knowledge: {
        ...input.knowledge,
        checkpoint: { branch: "main" },
      },
    }, "/workspace/system.yaml")).toThrowError(/Invalid system configuration/);
    expect(() => parseSystemConfig({
      ...input,
      knowledge: {
        ...input.knowledge,
        checkpoint: { ...input.knowledge.checkpoint, checkpointCron: "invalid" },
      },
    }, "/workspace/system.yaml")).toThrowError(/Cron expression must have 5 fields/);
  });

  it("resolves all configured paths relative to system.yaml", () => {
    const config = parseSystemConfig(validConfigInput(), "/workspace/system.yaml");
    expect(config.repositories[0]?.path).toBe("/workspace/loong-dashboard");
    expect(config.knowledge.path).toBe("/workspace/knowledge");
    expect(config.knowledge.inbox).toBe("/workspace/knowledge/inbox");
    expect(config.runtime.statePath).toBe("/workspace/.loong");
  });

  it("allows runtime host and port overrides without changing data paths", () => {
    const configPath = resolve(repositoryRoot, "system.example.yaml");
    const config = loadSystemConfig(configPath, {
      LOONGBOARD_SERVER_HOST: "  0.0.0.0 ",
      LOONGBOARD_SERVER_PORT: " 4180 ",
    });
    expect(config.runtime).toMatchObject({ serverHost: "0.0.0.0", serverPort: 4180 });
    expect(config.runtime.statePath).toBe(resolve(dirname(configPath), ".loong"));
  });

  it.each([
    ["duplicate repository key", (config: ReturnType<typeof validConfigInput>) => ({
      ...config,
      repositories: [
        ...config.repositories,
        { ...config.repositories[0], name: "Second", github: "other/project" },
      ],
    }), /Duplicate repository key/],
    ["duplicate GitHub slug", (config: ReturnType<typeof validConfigInput>) => ({
      ...config,
      repositories: [
        ...config.repositories,
        { ...config.repositories[0], key: "second", name: "Second" },
      ],
    }), /Duplicate GitHub repository/],
    ["invalid IANA timezone", (config: ReturnType<typeof validConfigInput>) => ({
      ...config,
      timezone: "Mars/Olympus",
    }), /valid IANA timezone/],
  ])("rejects $0 at the config boundary", (_label, createConfig, expected) => {
    expect(() => parseSystemConfig(createConfig(validConfigInput()), "/workspace/system.yaml"))
      .toThrowError(expected);
  });

  it("resolves the default config path from repository root or apps/server", () => {
    expect(resolveSystemConfigPath({}, repositoryRoot)).toBe(resolve(repositoryRoot, "..", "system.yaml"));
    expect(resolveSystemConfigPath({}, serverPackageDirectory)).toBe(resolve(repositoryRoot, "..", "system.yaml"));
    expect(resolveSystemConfigPath({ LOONGBOARD_SYSTEM_CONFIG: "config/custom.yaml" }, serverPackageDirectory))
      .toBe(resolve(repositoryRoot, "config/custom.yaml"));
  });
});
