import { randomBytes } from "node:crypto";

import type { DatabaseClient, RepositoryOnboardingError, RepositoryOnboardingInput, RepositoryOnboardingJob, RepositoryOnboardingStatus } from "./types.js";

type SqlRow = {
  id: string;
  status: RepositoryOnboardingStatus;
  step: RepositoryOnboardingStatus;
  detail: string;
  progress: number;
  github: string;
  clone_url: string;
  repository_key: string;
  display_name: string;
  remote_name: string;
  default_branch: string;
  target_path: string;
  worktree_slots: number;
  input_json: string;
  config_hash: string;
  repository_id: string | null;
  github_metadata_pending: number;
  error_code: string | null;
  error_message: string | null;
  error_retryable: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
};

export interface CreateRepositoryOnboardingJobInput {
  input: RepositoryOnboardingInput;
  configHash: string;
  now?: string;
  jobId?: string;
  detail?: string;
}

export interface UpdateRepositoryOnboardingJobInput {
  status?: RepositoryOnboardingStatus;
  step?: RepositoryOnboardingStatus;
  detail?: string;
  progress?: number;
  repositoryId?: string | null;
  githubMetadataPending?: boolean;
  error?: RepositoryOnboardingError | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  configHash?: string;
  /** Retry-only branch patch; persisted in both the indexed column and input JSON. */
  defaultBranch?: string;
  updatedAt?: string;
}

export interface RetryRepositoryOnboardingJobOptions {
  /** Startup recovery may requeue a previously-ready job after its checkout disappears. */
  allowReady?: boolean;
  /** Refresh the optimistic system.yaml guard after the caller validates current config. */
  configHash?: string;
  /** Optional branch patch accepted only before repository registration. */
  defaultBranch?: string;
}

export class RepositoryOnboardingNotFoundError extends Error {
  readonly code = "REPOSITORY_ONBOARDING_NOT_FOUND" as const;

  constructor(jobId: string) {
    super(`Repository onboarding job was not found: ${jobId}`);
    this.name = "RepositoryOnboardingNotFoundError";
  }
}

export class RepositoryOnboardingTransitionError extends Error {
  readonly code = "REPOSITORY_ONBOARDING_FAILED" as const;

  constructor(jobId: string, from: RepositoryOnboardingStatus, to: RepositoryOnboardingStatus) {
    super(`Invalid repository onboarding transition for ${jobId}: ${from} -> ${to}`);
    this.name = "RepositoryOnboardingTransitionError";
  }
}

const TERMINAL_STATES = new Set<RepositoryOnboardingStatus>([
  "ready",
  "failed",
  "cancelled",
]);

const TRANSITIONS: Record<RepositoryOnboardingStatus, readonly RepositoryOnboardingStatus[]> = {
  queued: ["validating", "cancelled", "failed"],
  validating: ["cloning", "registering", "failed", "cancelled"],
  cloning: ["registering", "failed", "cancelled"],
  registering: ["initializing", "failed"],
  initializing: ["syncing", "ready", "failed"],
  syncing: ["ready", "failed"],
  // A source checkout can be ready while its GitHub metadata credential is
  // pending; retrying that durable row continues initialization/sync after a
  // credential is configured.
  ready: ["queued"],
  failed: ["queued", "validating"],
  cancelled: ["queued"],
};

function mapJob(row: SqlRow): RepositoryOnboardingJob {
  let input: RepositoryOnboardingInput;
  try {
    const decoded: unknown = JSON.parse(row.input_json);
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw new Error("input is not an object");
    }
    input = {
      github: row.github,
      cloneUrl: row.clone_url,
      key: row.repository_key,
      displayName: row.display_name,
      remoteName: row.remote_name,
      defaultBranch: row.default_branch,
      targetPath: row.target_path,
      worktreeSlots: row.worktree_slots,
    };
  } catch {
    throw new Error(`Repository onboarding job has invalid persisted input: ${row.id}`);
  }
  const hasError = row.error_code !== null || row.error_message !== null || row.error_retryable !== null;
  const error = hasError
    ? {
        code: row.error_code ?? "REPOSITORY_ONBOARDING_FAILED",
        message: row.error_message ?? "Repository onboarding failed",
        retryable: row.error_retryable === 1,
      }
    : null;
  return {
    jobId: row.id,
    status: row.status,
    step: row.step,
    detail: row.detail,
    progress: row.progress,
    repositoryId: row.repository_id,
    githubMetadataPending: row.github_metadata_pending === 1,
    input,
    error,
    configHash: row.config_hash,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
  };
}

function rowById(database: DatabaseClient, jobId: string): SqlRow | undefined {
  return database.prepare(
    `SELECT id, status, step, detail, progress, github, clone_url,
            repository_key, display_name, remote_name, default_branch,
            target_path, worktree_slots, input_json, config_hash,
            repository_id, github_metadata_pending, error_code,
            error_message, error_retryable, created_at, started_at,
            finished_at, updated_at
     FROM repository_onboarding_jobs WHERE id = ?`,
  ).get(jobId) as SqlRow | undefined;
}

export function getRepositoryOnboardingJob(
  database: DatabaseClient,
  jobId: string,
): RepositoryOnboardingJob | null {
  const row = rowById(database, jobId);
  return row === undefined ? null : mapJob(row);
}

export function requireRepositoryOnboardingJob(
  database: DatabaseClient,
  jobId: string,
): RepositoryOnboardingJob {
  const job = getRepositoryOnboardingJob(database, jobId);
  if (job === null) throw new RepositoryOnboardingNotFoundError(jobId);
  return job;
}

export function listRepositoryOnboardingJobs(
  database: DatabaseClient,
  statuses?: readonly RepositoryOnboardingStatus[],
): RepositoryOnboardingJob[] {
  const rows = statuses !== undefined && statuses.length > 0
    ? database.prepare(
        `SELECT id, status, step, detail, progress, github, clone_url,
                repository_key, display_name, remote_name, default_branch,
                target_path, worktree_slots, input_json, config_hash,
                repository_id, github_metadata_pending, error_code,
                error_message, error_retryable, created_at, started_at,
                finished_at, updated_at
         FROM repository_onboarding_jobs
         WHERE status IN (${statuses.map(() => "?").join(",")})
         ORDER BY created_at ASC`,
      ).all(...statuses)
    : database.prepare(
        `SELECT id, status, step, detail, progress, github, clone_url,
                repository_key, display_name, remote_name, default_branch,
                target_path, worktree_slots, input_json, config_hash,
                repository_id, github_metadata_pending, error_code,
                error_message, error_retryable, created_at, started_at,
                finished_at, updated_at
         FROM repository_onboarding_jobs ORDER BY created_at ASC`,
      ).all();
  return (rows as SqlRow[]).map(mapJob);
}

export function createRepositoryOnboardingJob(
  database: DatabaseClient,
  input: CreateRepositoryOnboardingJobInput,
): RepositoryOnboardingJob {
  const now = input.now ?? new Date().toISOString();
  const jobId = input.jobId ?? `onboard_${randomBytes(10).toString("hex")}`;
  const detail = input.detail ?? "Queued for repository onboarding";
  const sanitized = JSON.stringify(input.input);
  database.prepare(
    `INSERT INTO repository_onboarding_jobs (
       id, status, step, detail, progress, github, clone_url,
       repository_key, display_name, remote_name, default_branch,
       target_path, worktree_slots, input_json, config_hash,
       repository_id, github_metadata_pending, error_code, error_message,
       error_retryable, created_at, started_at, finished_at, updated_at
     ) VALUES (?, 'queued', 'queued', ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
               NULL, 0, NULL, NULL, NULL, ?, NULL, NULL, ?)`,
  ).run(
    jobId,
    detail,
    input.input.github,
    input.input.cloneUrl,
    input.input.key,
    input.input.displayName,
    input.input.remoteName,
    input.input.defaultBranch,
    input.input.targetPath,
    input.input.worktreeSlots,
    sanitized,
    input.configHash,
    now,
    now,
  );
  return requireRepositoryOnboardingJob(database, jobId);
}

export function updateRepositoryOnboardingJob(
  database: DatabaseClient,
  jobId: string,
  patch: UpdateRepositoryOnboardingJobInput,
): RepositoryOnboardingJob {
  const existing = requireRepositoryOnboardingJob(database, jobId);
  if (patch.status !== undefined && patch.status !== existing.status) {
    if (existing.status === "ready" && patch.status === "queued" && !existing.githubMetadataPending) {
      throw new RepositoryOnboardingTransitionError(jobId, existing.status, patch.status);
    }
    if (!TRANSITIONS[existing.status].includes(patch.status)) {
      throw new RepositoryOnboardingTransitionError(jobId, existing.status, patch.status);
    }
  }
  if (patch.progress !== undefined &&
      (!Number.isInteger(patch.progress) || patch.progress < 0 || patch.progress > 100)) {
    throw new Error(`Invalid repository onboarding progress for ${jobId}`);
  }
  const nextStatus = patch.status ?? existing.status;
  const sets: string[] = [];
  const params: unknown[] = [];
  const add = (column: string, value: unknown): void => {
    sets.push(`${column} = ?`);
    params.push(value);
  };
  if (patch.status !== undefined) add("status", patch.status);
  if (patch.step !== undefined) add("step", patch.step);
  if (patch.detail !== undefined) add("detail", patch.detail);
  if (patch.progress !== undefined) add("progress", patch.progress);
  if (patch.repositoryId !== undefined) add("repository_id", patch.repositoryId);
  if (patch.githubMetadataPending !== undefined) add("github_metadata_pending", patch.githubMetadataPending ? 1 : 0);
  if (patch.error !== undefined) {
    add("error_code", patch.error?.code ?? null);
    add("error_message", patch.error?.message ?? null);
    add("error_retryable", patch.error?.retryable === undefined ? null : patch.error.retryable ? 1 : 0);
  }
  if (patch.startedAt !== undefined) add("started_at", patch.startedAt);
  if (patch.finishedAt !== undefined) add("finished_at", patch.finishedAt);
  if (patch.configHash !== undefined) add("config_hash", patch.configHash);
  if (patch.defaultBranch !== undefined) {
    if (existing.repositoryId !== null) {
      throw new RepositoryOnboardingTransitionError(jobId, existing.status, "queued");
    }
    if (patch.defaultBranch.trim().length === 0) {
      throw new Error(`Invalid repository onboarding default branch for ${jobId}`);
    }
    add("default_branch", patch.defaultBranch);
    add("input_json", JSON.stringify({ ...existing.input, defaultBranch: patch.defaultBranch }));
  }
  const now = patch.updatedAt ?? new Date().toISOString();
  add("updated_at", now);
  if (sets.length === 1 && sets[0] === "updated_at = ?") return existing;
  database.prepare(`UPDATE repository_onboarding_jobs SET ${sets.join(", ")} WHERE id = ?`).run(...params, jobId);
  const updated = requireRepositoryOnboardingJob(database, jobId);
  if (TERMINAL_STATES.has(nextStatus) && updated.finishedAt === null) {
    return updateRepositoryOnboardingJob(database, jobId, { finishedAt: now, updatedAt: now });
  }
  return updated;
}

/** Mark work that cannot survive a process restart as failed and retryable. */
export function recoverInterruptedRepositoryOnboardingJobs(
  database: DatabaseClient,
  now = new Date().toISOString(),
): number {
  const active = ["validating", "cloning", "registering", "initializing", "syncing"] as const;
  const result = database.prepare(
    `UPDATE repository_onboarding_jobs
     SET status = 'failed', step = 'failed',
         detail = 'Repository onboarding was interrupted by server restart',
         error_code = 'REPOSITORY_ONBOARDING_INTERRUPTED',
         error_message = 'Repository onboarding was interrupted by server restart; retry is available',
         error_retryable = 1, finished_at = ?, updated_at = ?
     WHERE status IN (${active.map(() => "?").join(",")})`,
  ).run(now, now, ...active);
  return result.changes;
}

export function cancelRepositoryOnboardingJob(
  database: DatabaseClient,
  jobId: string,
): RepositoryOnboardingJob {
  const job = requireRepositoryOnboardingJob(database, jobId);
  if (job.status === "cancelled") return job;
  if (job.status !== "queued" && job.status !== "validating" && job.status !== "cloning") {
    throw new RepositoryOnboardingTransitionError(jobId, job.status, "cancelled");
  }
  return updateRepositoryOnboardingJob(database, jobId, {
    status: "cancelled",
    step: "cancelled",
    detail: "Repository onboarding cancelled",
    progress: job.progress,
    error: null,
  });
}

export function retryRepositoryOnboardingJob(
  database: DatabaseClient,
  jobId: string,
  now = new Date().toISOString(),
  options: RetryRepositoryOnboardingJobOptions = {},
): RepositoryOnboardingJob {
  const job = requireRepositoryOnboardingJob(database, jobId);
  if (
    job.status !== "failed" &&
    job.status !== "cancelled" &&
    !(job.status === "ready" && (job.githubMetadataPending || options.allowReady === true))
  ) {
    throw new RepositoryOnboardingTransitionError(jobId, job.status, "queued");
  }
  if (options.defaultBranch !== undefined && job.repositoryId !== null) {
    throw new RepositoryOnboardingTransitionError(jobId, job.status, "queued");
  }
  return updateRepositoryOnboardingJob(database, jobId, {
    status: "queued",
    step: "queued",
    detail: "Queued for repository onboarding retry",
    progress: 0,
    error: null,
    githubMetadataPending: false,
    startedAt: null,
    finishedAt: null,
    ...(options.configHash === undefined ? {} : { configHash: options.configHash }),
    ...(options.defaultBranch === undefined ? {} : { defaultBranch: options.defaultBranch }),
    updatedAt: now,
  });
}

const ACTIVE_ONBOARDING_STATUSES = [
  "queued",
  "validating",
  "cloning",
  "registering",
  "initializing",
  "syncing",
] as const;

/**
 * Return the bounded Settings status projection. Active attempts are shown
 * together with only the newest failed attempt and newest ready attempt that
 * still awaits GitHub credentials; ordinary ready history is intentionally
 * omitted.
 */
export function listRepositoryOnboardingJobsForDisplay(
  database: DatabaseClient,
  limit = 10,
): RepositoryOnboardingJob[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
    throw new Error("Repository onboarding display limit must be between 1 and 10");
  }
  const rows = listRepositoryOnboardingJobs(database, [
    ...ACTIVE_ONBOARDING_STATUSES,
    "failed",
    "ready",
  ]);
  const active = rows.filter((job) => ACTIVE_ONBOARDING_STATUSES.includes(job.status as typeof ACTIVE_ONBOARDING_STATUSES[number]));
  const latestFailed = rows
    .filter((job) => job.status === "failed")
    .sort(compareOnboardingJobs)[0];
  const latestPendingReady = rows
    .filter((job) => job.status === "ready" && job.githubMetadataPending)
    .sort(compareOnboardingJobs)[0];
  const selected = [
    ...active,
    ...(latestFailed === undefined ? [] : [latestFailed]),
    ...(latestPendingReady === undefined ? [] : [latestPendingReady]),
  ];
  return selected
    .filter((job, index, all) => all.findIndex((candidate) => candidate.jobId === job.jobId) === index)
    .sort(compareOnboardingJobs)
    .slice(0, limit);
}

function compareOnboardingJobs(left: RepositoryOnboardingJob, right: RepositoryOnboardingJob): number {
  const updated = right.updatedAt.localeCompare(left.updatedAt);
  return updated !== 0 ? updated : right.createdAt.localeCompare(left.createdAt);
}
