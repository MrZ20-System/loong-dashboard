import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  listDomainRules,
  openDatabase,
  reconcileRepositories,
  type DatabaseClient,
} from "@loongboard/database";
import { DEFAULT_DOMAIN_UPDATE_PROMPT } from "@loongboard/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  DomainFileService,
  type DomainFileServiceOptions,
  DomainSourceInvalidError,
} from "../src/domain-file.js";

type TestWatcher = EventEmitter & { closeCalls: number; close(): void };

function testWatcher(): TestWatcher {
  const watcher = new EventEmitter() as TestWatcher;
  watcher.closeCalls = 0;
  watcher.close = () => {
    watcher.closeCalls += 1;
  };
  return watcher;
}

const resources: Array<{ database: DatabaseClient; root: string }> = [];

afterEach(() => {
  for (const resource of resources.splice(0)) {
    if (resource.database.open) resource.database.close();
    rmSync(resource.root, { recursive: true, force: true });
  }
});

function fixture(
  watchFactory?: NonNullable<DomainFileServiceOptions["watch"]>,
): { service: DomainFileService; database: DatabaseClient; root: string } {
  const root = mkdtempSync(join(tmpdir(), "loongboard-domain-file-"));
  const statePath = join(root, ".loong");
  mkdirSync(statePath, { recursive: true });
  const database = openDatabase(join(statePath, "state.sqlite3"));
  resources.push({ database, root });
  reconcileRepositories(database, [
    {
      key: "vllm.json",
      name: "vLLM",
      github: "openai/vllm",
      path: join(root, "vllm"),
      remote: "origin",
      defaultBranch: "main",
      worktreeSlots: 1,
    },
  ]);
  const service = new DomainFileService({
    database,
    systemRoot: root,
    statePath,
    reclassification: {
      trigger: () => ({ running: false, pendingCount: null }),
      status: () => ({ running: false, pendingCount: null }),
      close: async () => undefined,
    },
    ...(watchFactory === undefined ? {} : { watch: watchFactory }),
  });
  return { service, database, root };
}

describe("DomainFileService", () => {
  it("materializes the shared default Domain Agent prompt", () => {
    const { service } = fixture();
    const prompt = service.prompt();
    expect(prompt.content).toBe(DEFAULT_DOMAIN_UPDATE_PROMPT);
    expect(prompt.content).toContain("<我输入的内容>");
    expect(prompt.content).toContain('"domains": [');
  });

  it("upgrades an untouched legacy prompt without overwriting customized prompts", () => {
    const { service } = fixture();
    const legacyPrompt = `# Update domains

Analyze the repository and update the Domain definitions in the JSON file for this repository.

Keep the definitions useful for deterministic changed-file classification. Edit the JSON file directly, preserve useful existing metadata, and explain the changes in this conversation.`;
    mkdirSync(join(service.promptPath(), ".."), { recursive: true });
    writeFileSync(service.promptPath(), legacyPrompt, "utf8");

    expect(service.prompt().content).toBe(DEFAULT_DOMAIN_UPDATE_PROMPT);
    expect(readFileSync(service.promptPath(), "utf8")).toBe(DEFAULT_DOMAIN_UPDATE_PROMPT);

    const customPrompt = `${legacyPrompt}\n\nKeep my custom note.`;
    writeFileSync(service.promptPath(), customPrompt, "utf8");
    expect(service.prompt().content).toBe(customPrompt);
  });

  it("migrates the DB projection, preserves malformed source, and records restoreable history", () => {
    const { service, database, root } = fixture();
    const created = service.create("vllm.json", {
      name: "Docs",
      includePatterns: ["docs/**"],
    });
    const original = service.source("vllm.json");
    expect(original.path).toBe("domains/vllm.json.json");
    expect(original.version).toBeGreaterThan(0);
    expect(listDomainRules(database, "vllm.json")).toHaveLength(1);

    const malformed = "{\"domains\":[";
    writeFileSync(service.filePath("vllm.json"), malformed, "utf8");
    const readable = service.source("vllm.json");
    expect(readable.content).toBe(malformed);
    expect(readable.parseError).toContain("JSON syntax");
    expect(listDomainRules(database, "vllm.json")[0]?.id).toBe(created.id);

    expect(() => service.saveSource("vllm.json", malformed)).toThrow(
      DomainSourceInvalidError,
    );
    expect(readFileSync(service.filePath("vllm.json"), "utf8")).toBe(malformed);

    const saved = service.saveSource(
      "vllm.json",
      JSON.stringify({
        version: 1,
        repositoryId: "vllm.json",
        metadata: { owner: "docs" },
        domains: [
          {
            id: created.id,
            name: "Documentation",
            includePatterns: ["docs/**"],
            custom: { colorSource: "user" },
          },
        ],
      }),
    );
    expect(saved.parseError).toBeNull();
    expect(JSON.parse(saved.content).metadata).toEqual({ owner: "docs" });
    expect(JSON.parse(saved.content).domains[0].custom).toEqual({ colorSource: "user" });

    const versions = service.listVersions("domain", "vllm.json");
    expect(versions.length).toBeGreaterThanOrEqual(2);
    const originalVersion = versions
      .map((version) => service.version("domain", "vllm.json", version.id))
      .find((version) => version.content.includes('"name": "Docs"'));
    expect(originalVersion).toBeDefined();
    const restored = service.restoreSource("vllm.json", originalVersion!.id);
    expect(restored.content).toContain('"name": "Docs"');
    expect(service.version("domain", "vllm.json", restored.versionId!).content).toContain(
      '"name": "Docs"',
    );
    expect(root).toContain("loongboard-domain-file-");
  });

  it("uses readable names for normal keys and encoded names for unusual keys", () => {
    const { service } = fixture();
    expect(service.filePath("vllm.json")).toMatch(/domains\/vllm\.json\.json$/);
    expect(service.filePath("team/repo")).toMatch(/domains\/team%2Frepo\.json$/);
  });

  it("closes both watchers after an asynchronous error and ignores stale groups", async () => {
    const watchers: TestWatcher[] = [];
    const watchFactory = (() => {
      const watcher = testWatcher();
      watchers.push(watcher);
      return watcher;
    }) as unknown as NonNullable<DomainFileServiceOptions["watch"]>;
    const { service } = fixture(watchFactory);
    service.start();
    expect(watchers).toHaveLength(2);

    queueMicrotask(() => watchers[0]!.emit("error", new Error("domain watcher failed")));
    await Promise.resolve();
    expect(watchers[0]!.closeCalls).toBe(1);
    expect(watchers[1]!.closeCalls).toBe(1);

    service.start();
    expect(watchers).toHaveLength(4);
    queueMicrotask(() => watchers[1]!.emit("error", new Error("late prompt watcher error")));
    await Promise.resolve();
    expect(watchers[2]!.closeCalls).toBe(0);
    expect(watchers[3]!.closeCalls).toBe(0);
    await service.close();
    expect(watchers[2]!.closeCalls).toBe(1);
    expect(watchers[3]!.closeCalls).toBe(1);
    await service.close();
    expect(watchers[2]!.closeCalls).toBe(1);
    expect(watchers[3]!.closeCalls).toBe(1);
  });
});
