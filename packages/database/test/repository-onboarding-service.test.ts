import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  cancelRepositoryOnboardingJob,
  createRepositoryOnboardingJob,
  getRepositoryOnboardingJob,
  openDatabase,
  reconcileRepositories,
  recoverInterruptedRepositoryOnboardingJobs,
  retryRepositoryOnboardingJob,
  updateRepositoryOnboardingJob,
  type DatabaseClient,
} from "../src/index.js";

const directories: string[] = [];
const databases: DatabaseClient[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(): { database: DatabaseClient; input: {
  github: string;
  cloneUrl: string;
  key: string;
  displayName: string;
  remoteName: string;
  defaultBranch: string;
  targetPath: string;
  worktreeSlots: number;
} } {
  const root = mkdtempSync(join(tmpdir(), "loongboard-onboarding-"));
  directories.push(root);
  const database = openDatabase(join(root, "state.sqlite3"));
  databases.push(database);
  return {
    database,
    input: {
      github: "vllm-project/vllm",
      cloneUrl: "https://github.com/vllm-project/vllm.git",
      key: "vllm",
      displayName: "vLLM",
      remoteName: "upstream",
      defaultBranch: "main",
      targetPath: join(root, "repositories", "vllm"),
      worktreeSlots: 10,
    },
  };
}

describe("repository onboarding persistence", () => {
  it("persists sanitized input and recovers in-flight work as retryable", () => {
    const { database, input } = fixture();
    const job = createRepositoryOnboardingJob(database, {
      input,
      configHash: "config-hash",
      jobId: "onboard_test",
      now: "2026-09-13T00:00:00.000Z",
    });
    expect(job).toMatchObject({
      jobId: "onboard_test",
      status: "queued",
      input,
      configHash: "config-hash",
    });
    expect(database.prepare("SELECT input_json FROM repository_onboarding_jobs WHERE id = ?").pluck().get(job.jobId))
      .toBe(JSON.stringify(input));

    updateRepositoryOnboardingJob(database, job.jobId, {
      status: "validating",
      step: "validating",
      progress: 5,
    });
    updateRepositoryOnboardingJob(database, job.jobId, {
      status: "cloning",
      step: "cloning",
      progress: 20,
      startedAt: "2026-09-13T00:00:01.000Z",
    });
    expect(recoverInterruptedRepositoryOnboardingJobs(database, "2026-09-13T00:01:00.000Z")).toBe(1);
    const failed = getRepositoryOnboardingJob(database, job.jobId);
    expect(failed).toMatchObject({
      status: "failed",
      step: "failed",
      error: {
        code: "REPOSITORY_ONBOARDING_INTERRUPTED",
        retryable: true,
      },
      finishedAt: "2026-09-13T00:01:00.000Z",
    });

    const retried = retryRepositoryOnboardingJob(
      database,
      job.jobId,
      "2026-09-13T00:02:00.000Z",
      { configHash: "refreshed-config-hash", defaultBranch: "release" },
    );
    expect(retried).toMatchObject({
      status: "queued",
      progress: 0,
      error: null,
      configHash: "refreshed-config-hash",
      input: { defaultBranch: "release" },
    });
    expect(database.prepare("SELECT default_branch, input_json FROM repository_onboarding_jobs WHERE id = ?").get(job.jobId))
      .toEqual({
        default_branch: "release",
        input_json: JSON.stringify({ ...input, defaultBranch: "release" }),
      });
    const cancelled = cancelRepositoryOnboardingJob(database, job.jobId);
    expect(cancelled).toMatchObject({ status: "cancelled", step: "cancelled" });
  });

  it("rejects branch patches after registration and cancellation after cloning", () => {
    const { database, input } = fixture();
    reconcileRepositories(database, [{
      key: "vllm",
      name: "vLLM",
      github: input.github,
      path: input.targetPath,
      remote: input.remoteName,
      defaultBranch: input.defaultBranch,
      worktreeSlots: input.worktreeSlots,
    }]);
    const registered = createRepositoryOnboardingJob(database, {
      input,
      configHash: "config-hash",
      jobId: "onboard_registered",
    });
    updateRepositoryOnboardingJob(database, registered.jobId, {
      status: "failed",
      step: "failed",
      repositoryId: "vllm",
      error: { code: "CLONE_FAILED", message: "clone failed", retryable: true },
    });
    expect(() => retryRepositoryOnboardingJob(database, registered.jobId, undefined, {
      defaultBranch: "release",
    })).toThrow();

    const cloning = createRepositoryOnboardingJob(database, {
      input,
      configHash: "config-hash",
      jobId: "onboard_cloning",
    });
    updateRepositoryOnboardingJob(database, cloning.jobId, {
      status: "validating",
      step: "validating",
    });
    updateRepositoryOnboardingJob(database, cloning.jobId, {
      status: "cloning",
      step: "cloning",
    });
    expect(() => cancelRepositoryOnboardingJob(database, cloning.jobId)).not.toThrow();
    const registering = createRepositoryOnboardingJob(database, {
      input: { ...input, key: "vllm-registering" },
      configHash: "config-hash",
      jobId: "onboard_registering",
    });
    updateRepositoryOnboardingJob(database, registering.jobId, {
      status: "validating",
      step: "validating",
    });
    updateRepositoryOnboardingJob(database, registering.jobId, {
      status: "cloning",
      step: "cloning",
    });
    updateRepositoryOnboardingJob(database, registering.jobId, {
      status: "registering",
      step: "registering",
    });
    expect(() => cancelRepositoryOnboardingJob(database, registering.jobId)).toThrow();

    const initializing = createRepositoryOnboardingJob(database, {
      input: { ...input, key: "vllm-initializing" },
      configHash: "config-hash",
      jobId: "onboard_initializing",
    });
    for (const status of ["validating", "cloning", "registering", "initializing"] as const) {
      updateRepositoryOnboardingJob(database, initializing.jobId, { status, step: status });
    }
    expect(() => cancelRepositoryOnboardingJob(database, initializing.jobId)).toThrow();

    const syncing = createRepositoryOnboardingJob(database, {
      input: { ...input, key: "vllm-syncing" },
      configHash: "config-hash",
      jobId: "onboard_syncing",
    });
    for (const status of ["validating", "cloning", "registering", "initializing", "syncing"] as const) {
      updateRepositoryOnboardingJob(database, syncing.jobId, { status, step: status });
    }
    expect(() => cancelRepositoryOnboardingJob(database, syncing.jobId)).toThrow();

    const ready = createRepositoryOnboardingJob(database, {
      input: { ...input, key: "vllm-ready" },
      configHash: "config-hash",
      jobId: "onboard_ready",
    });
    for (const status of ["validating", "cloning", "registering", "initializing", "ready"] as const) {
      updateRepositoryOnboardingJob(database, ready.jobId, { status, step: status });
    }
    expect(() => cancelRepositoryOnboardingJob(database, ready.jobId)).toThrow();
  });
});
