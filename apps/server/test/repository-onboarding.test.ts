import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createRepositoryOnboardingJob,
  getRepository,
  openDatabase,
  updateRepositoryOnboardingJob,
  type DatabaseClient,
} from "@loongboard/database";
import { repositoryOnboardingSchema, type RepositoryOnboarding } from "@loongboard/contracts";
import type {
  RepositoryCloneResult,
  RepositoryInspection,
  RepositoryOnboardingGit,
} from "@loongboard/git-workspace";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { parseSystemConfig } from "../src/config.js";
import {
  normalizeRepositoryOnboardingInput,
  parseGithubRepositoryUrl,
  RepositoryOnboardingService,
} from "../src/repository-onboarding.js";
import { registerRepositoryOnboardingRoutes } from "../src/routes/repository-onboarding.js";
import { registerRepositoryRoutes } from "../src/routes/repositories.js";

const roots: string[] = [];
const databases: DatabaseClient[] = [];
const services: RepositoryOnboardingService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fakeGit(): RepositoryOnboardingGit {
  return {
    async inspect(input): Promise<RepositoryInspection> {
      throw new Error(`missing checkout: ${input.targetPath}`);
    },
    async ensure(input): Promise<RepositoryCloneResult> {
      mkdirSync(input.targetPath, { recursive: true });
      return {
        action: "cloned",
        targetPath: input.targetPath,
        owner: input.owner,
        name: input.name,
        remoteName: input.remoteName,
        defaultBranch: input.defaultBranch,
        remoteMatched: true,
        defaultBranchAvailable: true,
      };
    },
    async adopt(input): Promise<RepositoryInspection> {
      return {
        action: "adopted",
        targetPath: input.targetPath,
        owner: input.owner,
        name: input.name,
        remoteName: input.remoteName,
        defaultBranch: input.defaultBranch,
        remoteMatched: true,
        defaultBranchAvailable: true,
      };
    },
    async clone(input): Promise<RepositoryCloneResult> {
      return (await this.ensure(input)) as RepositoryCloneResult;
    },
  } as RepositoryOnboardingGit;
}

function serviceFixture() {
  const root = mkdtempSync(join(tmpdir(), "loongboard-repository-onboarding-"));
  roots.push(root);
  const configPath = join(root, "system.yaml");
  writeFileSync(configPath, [
    "version: 1",
    "timezone: UTC",
    "repositories: []",
    "knowledge:",
    "  path: ./knowledge",
    "  inbox: inbox",
    "  historyLimit: 10",
    "runtime:",
    "  statePath: ./.loong",
    "  repositoriesPath: ./repositories",
    "  worktreesPath: ./.worktrees",
    "  serverHost: 127.0.0.1",
    "  serverPort: 4174",
    "agent:",
    "  defaultProvider: provider",
    "  defaultModel: model",
    "  defaultReasoningEffort: high",
  ].join("\n") + "\n", "utf8");
  const config = parseSystemConfig(JSON.parse(JSON.stringify({
    version: 1,
    timezone: "UTC",
    repositories: [],
    knowledge: { path: "./knowledge", inbox: "inbox", historyLimit: 10 },
    runtime: {
      statePath: "./.loong",
      repositoriesPath: "./repositories",
      worktreesPath: "./.worktrees",
      serverHost: "127.0.0.1",
      serverPort: 4174,
    },
    agent: {
      defaultProvider: "provider",
      defaultModel: "model",
      defaultReasoningEffort: "high",
    },
  })), configPath);
  mkdirSync(config.runtime.statePath, { recursive: true });
  const database = openDatabase(join(config.runtime.statePath, "state.sqlite3"));
  databases.push(database);
  const createService = () => new RepositoryOnboardingService({
    database,
    config,
    configPath,
    gitWorkspace: fakeGit(),
    settings: {
      repositorySettingsSync: () => ({
        repositoryId: "vllm-project-vllm",
        automaticSync: false,
        syncFrequencyMinutes: 60,
        syncLookbackDays: 7,
        retention: {
          automaticArchiveEnabled: false,
          archiveAfterDays: 7,
          includeMergedPrs: true,
          includeClosedPrs: true,
          includeClosedIssues: true,
          prunePayloadWhenArchived: true,
        },
        worktrees: {
          configuredSlots: 10,
          idleCleanupTtlHours: 24,
          physicalSlots: 0,
          active: 0,
          idle: 0,
          dirty: 0,
          pendingRetirement: 0,
        },
      }),
    },
    domainFiles: { refresh: () => undefined as never },
    projector: { projectRepository: () => undefined as never },
    credentialSummary: () => ({ configured: false }),
  });
  const service = createService();
  services.push(service);
  return {
    root,
    configPath,
    config,
    database,
    service,
    restartService: () => {
      const restarted = createService();
      services.push(restarted);
      return restarted;
    },
  };
}

async function waitFor(
  service: RepositoryOnboardingService,
  jobId: string,
  expected: RepositoryOnboarding["status"],
): Promise<RepositoryOnboarding> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = service.get(jobId) as unknown as RepositoryOnboarding;
    if (job.status === expected) return job;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  return service.get(jobId) as unknown as RepositoryOnboarding;
}

describe("repository onboarding", () => {
  it("normalizes GitHub forms and rejects paths outside the managed root", () => {
    expect(parseGithubRepositoryUrl("git@github.com:VLLM-Project/vLLM.git")).toEqual({
      owner: "vllm-project",
      name: "vllm",
    });
    expect(parseGithubRepositoryUrl("https://github.com/vllm-project/vllm/")).toEqual({
      owner: "vllm-project",
      name: "vllm",
    });
    expect(normalizeRepositoryOnboardingInput(
      { url: "vllm-project/vllm" },
      "/tmp/managed-repositories",
    ).targetPath).toBe("/tmp/managed-repositories/vllm-project-vllm");
    expect(() => normalizeRepositoryOnboardingInput(
      { url: "https://gitlab.com/owner/repo" },
      "/tmp/managed-repositories",
    )).toThrow(/github\.com/);
  });

  it("clones, registers, initializes, and reports pending metadata credentials", async () => {
    const fixture = serviceFixture();
    const job = fixture.service.enqueue({ url: "vllm-project/vllm" });
    const ready = await waitFor(fixture.service, job.jobId, "ready");
    expect(ready.githubMetadataPending).toBe(true);
    expect(ready.repositoryId).toBe("vllm-project-vllm");
    expect(getRepository(fixture.database, "vllm-project-vllm")).not.toBeNull();
    expect(readFileSync(fixture.configPath, "utf8")).toContain("github: vllm-project/vllm");
    expect(fixture.config.repositories).toHaveLength(1);
  });

  it("exposes the accepted and durable lifecycle route contracts", async () => {
    const fixture = serviceFixture();
    const app = Fastify();
    registerRepositoryRoutes(app, { database: fixture.database, onboarding: fixture.service });
    registerRepositoryOnboardingRoutes(app, { onboarding: fixture.service });
    const accepted = await app.inject({
      method: "POST",
      url: "/api/repositories",
      payload: { url: "vllm-project/vllm" },
    });
    expect(accepted.statusCode).toBe(202);
    const acceptedBody = JSON.parse(accepted.body) as { jobId: string; status: string };
    expect(acceptedBody.status).toBe("accepted");
    const status = await app.inject({
      method: "GET",
      url: `/api/repository-onboarding/${acceptedBody.jobId}`,
    });
    expect(status.statusCode).toBe(200);
    expect(repositoryOnboardingSchema.safeParse(JSON.parse(status.body)).success).toBe(true);
    await app.close();
  });

  it("recovers interrupted work and reuses a ready job when a configured checkout disappears", async () => {
    const fixture = serviceFixture();
    const interruptedInput = normalizeRepositoryOnboardingInput(
      { url: "owner/interrupted" },
      fixture.config.runtime.repositoriesPath,
    );
    const interrupted = createRepositoryOnboardingJob(fixture.database, {
      input: interruptedInput,
      configHash: "initial-hash",
      jobId: "onboard_interrupted",
    });
    updateRepositoryOnboardingJob(fixture.database, interrupted.jobId, {
      status: "validating",
      step: "validating",
      progress: 5,
    });
    fixture.service.start();
    expect(fixture.service.get(interrupted.jobId)).toMatchObject({
      status: "failed",
      error: { code: "REPOSITORY_ONBOARDING_INTERRUPTED", retryable: true },
    });

    const accepted = fixture.service.enqueue({ url: "vllm-project/vllm" });
    const firstReady = await waitFor(fixture.service, accepted.jobId, "ready");
    expect(firstReady.repositoryId).toBe("vllm-project-vllm");
    rmSync(firstReady.input.targetPath, { recursive: true, force: true });
    await fixture.service.close();

    const restarted = fixture.restartService();
    restarted.start();
    const recovered = await waitFor(restarted, accepted.jobId, "ready");
    expect(recovered.jobId).toBe(accepted.jobId);
    expect(recovered.githubMetadataPending).toBe(true);
    expect(existsSync(recovered.input.targetPath)).toBe(true);
  });
});
