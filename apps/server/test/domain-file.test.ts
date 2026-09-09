import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  listDomainRules,
  openDatabase,
  reconcileRepositories,
  type DatabaseClient,
} from "@loongboard/database";
import { afterEach, describe, expect, it } from "vitest";

import {
  DomainFileService,
  DomainSourceInvalidError,
} from "../src/domain-file.js";

const resources: Array<{ database: DatabaseClient; root: string }> = [];

afterEach(() => {
  for (const resource of resources.splice(0)) {
    if (resource.database.open) resource.database.close();
    rmSync(resource.root, { recursive: true, force: true });
  }
});

function fixture(): { service: DomainFileService; database: DatabaseClient; root: string } {
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
  });
  return { service, database, root };
}

describe("DomainFileService", () => {
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
});
