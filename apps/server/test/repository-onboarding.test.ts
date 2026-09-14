import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createRepositoryOnboardingJob,
  getRepository,
  openDatabase,
  retryRepositoryOnboardingJob,
  updateRepositoryOnboardingJob,
  type DatabaseClient,
} from "@loongboard/database";
import {
  repositoryOnboardingListResponseSchema,
  repositoryOnboardingSchema,
  type RepositoryOnboarding,
} from "@loongboard/contracts";
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

function fakeGit(options: {
  returnedDefaultBranch?: string;
  ensureError?: Error;
} = {}): RepositoryOnboardingGit {
  return {
    async inspect(input): Promise<RepositoryInspection> {
      throw new Error(`missing checkout: ${input.targetPath}`);
    },
    async ensure(input): Promise<RepositoryCloneResult> {
      if (options.ensureError !== undefined) throw options.ensureError;
      mkdirSync(input.targetPath, { recursive: true });
      return {
        action: "cloned",
        targetPath: input.targetPath,
        owner: input.owner,
        name: input.name,
        remoteName: input.remoteName,
        defaultBranch: options.returnedDefaultBranch ?? input.defaultBranch,
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

function serviceFixture(options: { gitWorkspace?: RepositoryOnboardingGit; returnedDefaultBranch?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "loongboard-repository-onboarding-"));
  roots.push(root);
  const configPath = join(root, "system.yaml");
  writeFileSync(configPath, [
    "version: 2",
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
    version: 2,
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
  let projectedPolicy: unknown;
  const createService = () => new RepositoryOnboardingService({
    database,
    config,
    configPath,
    gitWorkspace: options.gitWorkspace ?? fakeGit({ returnedDefaultBranch: options.returnedDefaultBranch }),
    settings: {
      repositorySettingsSync: () => ({
        automaticSync: false,
        syncCron: "0 * * * *",
        retention: {
          automaticArchiveEnabled: false,
          archiveAfterDays: 7,
          includeMergedPrs: true,
          includeClosedPrs: true,
          includeClosedIssues: true,
          prunePayloadWhenArchived: true,
        },
      }),
    },
    domainFiles: { refresh: () => undefined as never },
    projector: {
      projectRepository: (_repository, settings) => {
        projectedPolicy = settings;
        return undefined as never;
      },
    },
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
    projectedPolicy: () => projectedPolicy,
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
    const normalized = normalizeRepositoryOnboardingInput(
      { url: "vllm-project/vllm" },
      "/tmp/managed-repositories",
    );
    expect(normalized.targetPath).toBe("/tmp/managed-repositories/vllm-project-vllm");
    expect(normalized.defaultBranch).toBe("main");
    expect(() => normalizeRepositoryOnboardingInput(
      { url: "https://gitlab.com/owner/repo" },
      "/tmp/managed-repositories",
    )).toThrow(/github\.com/);
  });

  it("clones, registers, initializes, and reports pending metadata credentials", async () => {
    const fixture = serviceFixture({ returnedDefaultBranch: "remote-default" });
    const job = fixture.service.enqueue({ url: "vllm-project/vllm" });
    const ready = await waitFor(fixture.service, job.jobId, "ready");
    expect(ready.githubMetadataPending).toBe(true);
    expect(ready.repositoryId).toBe("vllm-project-vllm");
    expect(ready.input.defaultBranch).toBe("main");
    expect(getRepository(fixture.database, "vllm-project-vllm")).not.toBeNull();
    expect(readFileSync(fixture.configPath, "utf8")).toContain("github: vllm-project/vllm");
    expect(readFileSync(fixture.configPath, "utf8")).toContain("defaultBranch: main");
    expect(fixture.config.repositories).toHaveLength(1);
    expect(fixture.projectedPolicy()).toMatchObject({
      automaticSync: false,
      syncCron: "0 * * * *",
    });
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
    const listed = await app.inject({
      method: "GET",
      url: "/api/repository-onboarding",
    });
    expect(listed.statusCode).toBe(200);
    expect(repositoryOnboardingListResponseSchema.safeParse(JSON.parse(listed.body)).success).toBe(true);
    await app.close();
  });

  it("returns HTTP 409 when cancellation reaches registering", async () => {
    const fixture = serviceFixture();
    const input = normalizeRepositoryOnboardingInput(
      { url: "owner/registering-cancel" },
      fixture.config.runtime.repositoriesPath,
    );
    const job = createRepositoryOnboardingJob(fixture.database, {
      input,
      configHash: "config-hash",
      jobId: "onboard_registering_cancel_http",
    });
    updateRepositoryOnboardingJob(fixture.database, job.jobId, {
      status: "validating",
      step: "validating",
    });
    updateRepositoryOnboardingJob(fixture.database, job.jobId, {
      status: "cloning",
      step: "cloning",
    });
    updateRepositoryOnboardingJob(fixture.database, job.jobId, {
      status: "registering",
      step: "registering",
    });

    const app = Fastify();
    app.setErrorHandler((error, _request, reply) => {
      const code = error !== null && typeof error === "object" && "code" in error
        ? String(error.code)
        : "UNKNOWN";
      return reply.code(code === "REPOSITORY_ONBOARDING_FAILED" ? 409 : 500).send({ error: { code } });
    });
    registerRepositoryOnboardingRoutes(app, { onboarding: fixture.service });
    const response = await app.inject({
      method: "POST",
      url: `/api/repository-onboarding/${job.jobId}/cancel`,
    });
    expect(response.statusCode).toBe(409);
    expect(fixture.service.get(job.jobId).status).toBe("registering");
    await app.close();
  });

  it("persists a clear failure when the requested main branch is missing", async () => {
    const missingBranch = Object.assign(
      new Error("default branch main does not exist"),
      { code: "default_branch_missing" },
    );
    const fixture = serviceFixture({ gitWorkspace: fakeGit({ ensureError: missingBranch }) });
    const job = fixture.service.enqueue({ url: "owner/missing-main" });
    const failed = await waitFor(fixture.service, job.jobId, "failed");
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatchObject({ code: "default_branch_missing", retryable: true });
    expect(failed.error?.message ?? "").toMatch(/default branch.*main/i);
    expect(failed.error?.message ?? "").toMatch(/not exist/i);
  });

  it("keeps the persisted branch when retry is submitted with an empty body", async () => {
    const fixture = serviceFixture();
    const input = normalizeRepositoryOnboardingInput(
      { url: "owner/empty-body", defaultBranch: "feature" },
      fixture.config.runtime.repositoriesPath,
    );
    const configHash = createHash("sha256")
      .update(readFileSync(fixture.configPath))
      .digest("hex");
    const failed = createRepositoryOnboardingJob(fixture.database, {
      input,
      configHash,
      jobId: "onboard_empty_retry_body",
    });
    updateRepositoryOnboardingJob(fixture.database, failed.jobId, {
      status: "failed",
      step: "failed",
      error: { code: "CLONE_FAILED", message: "clone failed", retryable: true },
    });

    const app = Fastify();
    registerRepositoryOnboardingRoutes(app, { onboarding: fixture.service });
    const response = await app.inject({
      method: "POST",
      url: `/api/repository-onboarding/${failed.jobId}/retry`,
    });
    expect(response.statusCode).toBe(202);
    const ready = await waitFor(fixture.service, failed.jobId, "ready");
    expect(ready.input.defaultBranch).toBe("feature");
    expect(readFileSync(fixture.configPath, "utf8")).toContain("defaultBranch: feature");
    await app.close();
  });

  it("refreshes the YAML hash and persists a pre-registration branch retry", async () => {
    const fixture = serviceFixture();
    const input = normalizeRepositoryOnboardingInput(
      { url: "owner/retry" },
      fixture.config.runtime.repositoriesPath,
    );
    const failed = createRepositoryOnboardingJob(fixture.database, {
      input,
      configHash: "stale-hash",
      jobId: "onboard_retry_branch",
    });
    updateRepositoryOnboardingJob(fixture.database, failed.jobId, {
      status: "failed",
      step: "failed",
      error: { code: "CLONE_FAILED", message: "clone failed", retryable: true },
    });
    const changedRaw = `${readFileSync(fixture.configPath, "utf8")}# external change\n`;
    writeFileSync(fixture.configPath, changedRaw, "utf8");

    const app = Fastify();
    registerRepositoryOnboardingRoutes(app, { onboarding: fixture.service });
    const response = await app.inject({
      method: "POST",
      url: `/api/repository-onboarding/${failed.jobId}/retry`,
      payload: { defaultBranch: "release" },
    });
    expect(response.statusCode).toBe(202);
    const ready = await waitFor(fixture.service, failed.jobId, "ready");
    expect(ready.input.defaultBranch).toBe("release");
    expect(ready.repositoryId).toBe("owner-retry");
    expect(fixture.database.prepare("SELECT config_hash FROM repository_onboarding_jobs WHERE id = ?").pluck().get(failed.jobId))
      .toBe(createHash("sha256").update(changedRaw).digest("hex"));
    await app.close();

    const registered = fixture.service.enqueue({ url: "owner/registered" });
    const registeredReady = await waitFor(fixture.service, registered.jobId, "ready");
    expect(() => fixture.service.retry(registeredReady.jobId, { defaultBranch: "other" })).toThrow(/registered/i);
  });

  it("lists active jobs plus only the newest failed and pending-ready rows", () => {
    const fixture = serviceFixture();
    const create = (url: string, jobId: string, now: string) => createRepositoryOnboardingJob(
      fixture.database,
      {
        input: normalizeRepositoryOnboardingInput({ url }, fixture.config.runtime.repositoriesPath),
        configHash: "hash",
        jobId,
        now,
      },
    );
    const active = create("owner/active", "onboard_active", "2026-09-14T00:00:00.000Z");
    updateRepositoryOnboardingJob(fixture.database, active.jobId, {
      status: "validating",
      step: "validating",
      updatedAt: "2026-09-14T00:01:00.000Z",
    });
    const failedOld = create("owner/failed-old", "onboard_failed_old", "2026-09-14T00:02:00.000Z");
    updateRepositoryOnboardingJob(fixture.database, failedOld.jobId, {
      status: "failed",
      step: "failed",
      error: { code: "CLONE_FAILED", message: "old", retryable: true },
      updatedAt: "2026-09-14T00:03:00.000Z",
    });
    const failedNew = create("owner/failed-new", "onboard_failed_new", "2026-09-14T00:04:00.000Z");
    updateRepositoryOnboardingJob(fixture.database, failedNew.jobId, {
      status: "failed",
      step: "failed",
      error: { code: "CLONE_FAILED", message: "new", retryable: true },
      updatedAt: "2026-09-14T00:05:00.000Z",
    });
    const pending = create("owner/pending", "onboard_pending", "2026-09-14T00:06:00.000Z");
    updateRepositoryOnboardingJob(fixture.database, pending.jobId, {
      status: "validating",
      step: "validating",
    });
    updateRepositoryOnboardingJob(fixture.database, pending.jobId, {
      status: "registering",
      step: "registering",
    });
    updateRepositoryOnboardingJob(fixture.database, pending.jobId, {
      status: "initializing",
      step: "initializing",
    });
    updateRepositoryOnboardingJob(fixture.database, pending.jobId, {
      status: "ready",
      step: "ready",
      githubMetadataPending: true,
      progress: 100,
      updatedAt: "2026-09-14T00:07:00.000Z",
    });
    const normal = create("owner/normal", "onboard_normal", "2026-09-14T00:08:00.000Z");
    updateRepositoryOnboardingJob(fixture.database, normal.jobId, {
      status: "failed",
      step: "failed",
      error: { code: "CLONE_FAILED", message: "normal", retryable: true },
    });
    retryRepositoryOnboardingJob(fixture.database, normal.jobId, "2026-09-14T00:09:00.000Z");
    updateRepositoryOnboardingJob(fixture.database, normal.jobId, {
      status: "validating",
      step: "validating",
    });
    updateRepositoryOnboardingJob(fixture.database, normal.jobId, {
      status: "registering",
      step: "registering",
    });
    updateRepositoryOnboardingJob(fixture.database, normal.jobId, {
      status: "initializing",
      step: "initializing",
    });
    updateRepositoryOnboardingJob(fixture.database, normal.jobId, {
      status: "ready",
      step: "ready",
      progress: 100,
      updatedAt: "2026-09-14T00:10:00.000Z",
    });

    const listed = fixture.service.list();
    expect(listed.map((job) => job.jobId)).toEqual([
      "onboard_pending",
      "onboard_failed_new",
      "onboard_active",
    ]);
    expect(listed.some((job) => job.jobId === "onboard_failed_old")).toBe(false);
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
    const resumedInterrupted = await waitFor(fixture.service, interrupted.jobId, "ready");
    expect(resumedInterrupted.repositoryId).toBe("owner-interrupted");
    expect(resumedInterrupted.error).toBeNull();

    const accepted = fixture.service.enqueue({ url: "vllm-project/vllm" });
    const firstReady = await waitFor(fixture.service, accepted.jobId, "ready");
    expect(firstReady.repositoryId).toBe("vllm-project-vllm");
    rmSync(firstReady.input.targetPath, { recursive: true, force: true });
    await fixture.service.close();

    const restarted = fixture.restartService();
    restarted.start();
    const recovered = await waitFor(restarted, accepted.jobId, "ready");
    for (let attempt = 0; attempt < 100 && !existsSync(recovered.input.targetPath); attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }
    expect(recovered.jobId).toBe(accepted.jobId);
    expect(recovered.githubMetadataPending).toBe(true);
    expect(existsSync(recovered.input.targetPath)).toBe(true);
  });
});
