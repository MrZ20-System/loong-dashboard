import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  cancelRepositoryOnboardingJob,
  createRepositoryOnboardingJob,
  getRepository,
  getRepositoryOnboardingJob,
  listRepositoryOnboardingJobs,
  listRepositoryOnboardingJobsForDisplay,
  recoverInterruptedRepositoryOnboardingJobs,
  reconcileRepositories,
  requireRepositoryOnboardingJob,
  retryRepositoryOnboardingJob,
  updateRepositoryOnboardingJob,
  type DatabaseClient,
  type RepositoryOnboardingJob,
} from "@loongboard/database";
import {
  repositoryOnboardingCreateSchema,
  repositoryOnboardingInputSchema,
  repositoryOnboardingSchema,
  type RepositoryRetentionSettings,
  type RepositoryOnboardingCreate,
  type RepositoryOnboardingInput,
  type RepositoryOnboarding,
  type RepositoryOnboardingRetry,
} from "@loongboard/contracts";
import {
  RepositoryOnboardingGit as GitWorkspaceOnboarding,
  type RepositoryCloneResult as GitRepositoryCloneResult,
  type RepositoryCredential,
  type RepositoryInspection as GitRepositoryInspection,
  type RepositoryOnboardingInput as GitWorkspaceOnboardingInput,
  type RepositoryOnboardingOptions as GitWorkspaceOnboardingOptions,
} from "@loongboard/git-workspace";
import { parseDocument, parse as parseYaml } from "yaml";

import { atomicWrite, isWithinRoot } from "@loongboard/knowledge";
import {
  parseSystemConfig,
  type SystemConfig,
} from "./config.js";
import type { DomainFileService } from "./domain-file.js";
import type { RepositorySyncCoordinator } from "./sync-coordinator.js";
import type { SystemScheduleProjector } from "./system-schedules.js";
import { InvalidRequestError } from "./route-helpers.js";

const DEFAULT_REMOTE = "upstream";
const DEFAULT_BRANCH = "main";
const DEFAULT_WORKTREE_SLOTS = 10;

interface RepositoryOnboardingSettings {
  automaticSync: boolean;
  syncCron: string;
  retention: RepositoryRetentionSettings;
}

export interface RepositoryOnboardingCredentialSummary {
  configured: boolean;
}

export interface RepositoryOnboardingServiceOptions {
  database: DatabaseClient;
  config: SystemConfig;
  configPath: string;
  gitWorkspace: GitWorkspaceOnboarding;
  settings?: {
    repositorySettingsSync(repositoryId: string): RepositoryOnboardingSettings;
  };
  domainFiles?: Pick<DomainFileService, "refresh">;
  projector?: Pick<SystemScheduleProjector, "projectRepository">;
  syncCoordinator?: Pick<RepositorySyncCoordinator, "start" | "waitForRun">;
  credentialSummary?: () =>
    | RepositoryOnboardingCredentialSummary
    | Promise<RepositoryOnboardingCredentialSummary>;
  credentialToken?: () => Promise<string | null> | string | null;
  now?: () => Date;
  logger?: { error(...arguments_: readonly unknown[]): void };
}

export class RepositoryOnboardingConflictError extends Error {
  readonly code = "REPOSITORY_ONBOARDING_CONFLICT" as const;

  constructor(message: string) {
    super(message);
    this.name = "RepositoryOnboardingConflictError";
  }
}

export class RepositoryOnboardingService {
  private readonly database: DatabaseClient;
  private readonly config: SystemConfig;
  private readonly configPath: string;
  private readonly gitWorkspace: GitWorkspaceOnboarding;
  private readonly settings: RepositoryOnboardingServiceOptions["settings"];
  private readonly domainFiles: RepositoryOnboardingServiceOptions["domainFiles"];
  private readonly projector: RepositoryOnboardingServiceOptions["projector"];
  private readonly syncCoordinator: RepositoryOnboardingServiceOptions["syncCoordinator"];
  private readonly credentialSummary: RepositoryOnboardingServiceOptions["credentialSummary"];
  private readonly credentialToken: RepositoryOnboardingServiceOptions["credentialToken"];
  private readonly now: () => Date;
  private readonly logger: NonNullable<RepositoryOnboardingServiceOptions["logger"]>;
  private readonly active = new Map<string, { abort: AbortController; promise: Promise<void> }>();
  private configWriteMutex: Promise<void> = Promise.resolve();
  private lastWrittenConfigHash: string | null = null;
  private closed = false;
  private scanStarted = false;

  constructor(options: RepositoryOnboardingServiceOptions) {
    this.database = options.database;
    this.config = options.config;
    this.configPath = resolve(options.configPath);
    this.gitWorkspace = options.gitWorkspace;
    this.settings = options.settings;
    this.domainFiles = options.domainFiles;
    this.projector = options.projector;
    this.syncCoordinator = options.syncCoordinator;
    this.credentialSummary = options.credentialSummary;
    this.credentialToken = options.credentialToken;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? { error: () => undefined };
    if (options.config.runtime.repositoriesPath.trim().length === 0) {
      throw new Error("Repository onboarding managed root must not be empty");
    }
    ensureManagedRoot(options.config.runtime.repositoriesPath);
  }

  /** Enqueue a user-requested onboarding job and return before clone begins. */
  enqueue(raw: RepositoryOnboardingCreate): RepositoryOnboarding {
    const request = repositoryOnboardingCreateSchema.parse(raw);
    const normalized = normalizeRepositoryOnboardingInput(
      request,
      this.config.runtime.repositoriesPath,
    );
    this.assertNoDuplicate(normalized);
    const job = createRepositoryOnboardingJob(this.database, {
      input: normalized,
      configHash: hashFile(this.configPath),
      now: this.timestamp(),
    });
    this.schedule(job.jobId);
    return this.publicJob(job);
  }

  get(jobId: string): RepositoryOnboarding {
    return this.publicJob(requireRepositoryOnboardingJob(this.database, jobId));
  }

  list(): RepositoryOnboarding[] {
    return listRepositoryOnboardingJobsForDisplay(this.database, 10).map((job) => this.publicJob(job));
  }

  retry(jobId: string, patch: RepositoryOnboardingRetry = {}): RepositoryOnboarding {
    const current = requireRepositoryOnboardingJob(this.database, jobId);
    const defaultBranch = patch.defaultBranch?.trim();
    if (defaultBranch !== undefined && current.repositoryId !== null) {
      throw new RepositoryOnboardingConflictError(
        "A registered repository cannot change its default branch through onboarding retry",
      );
    }
    const configHash = this.refreshConfigForRetry(current);
    const job = retryRepositoryOnboardingJob(
      this.database,
      jobId,
      this.timestamp(),
      {
        configHash,
        ...(defaultBranch === undefined ? {} : { defaultBranch }),
      },
    );
    this.schedule(job.jobId);
    return this.publicJob(job);
  }

  cancel(jobId: string): RepositoryOnboarding {
    // Persist cancellation before signaling the worker. If registration has
    // already won the race, the typed DB service rejects this as an invalid
    // state and no rollback is attempted.
    const cancelled = cancelRepositoryOnboardingJob(this.database, jobId);
    this.active.get(jobId)?.abort.abort();
    return this.publicJob(cancelled);
  }

  /**
   * Arm queued jobs and scan configured managed repositories. This method is
   * intentionally non-blocking so HTTP listen is never held by a large clone.
   */
  start(): void {
    if (this.closed || this.scanStarted) return;
    recoverInterruptedRepositoryOnboardingJobs(this.database, this.timestamp());
    this.scanStarted = true;
    // Recovery intentionally records an interrupted attempt as failed first,
    // then immediately requeues only that machine-generated failure. This
    // lets a pre-registration crash resume even when system.yaml has not yet
    // gained the repository entry; user-declared failures remain manual.
    for (const job of listRepositoryOnboardingJobs(this.database, ["failed"])) {
      if (job.error?.code !== "REPOSITORY_ONBOARDING_INTERRUPTED") continue;
      try {
        const configHash = this.refreshConfigForRetry(job);
        const resumed = retryRepositoryOnboardingJob(
          this.database,
          job.jobId,
          this.timestamp(),
          { configHash },
        );
        this.schedule(resumed.jobId);
      } catch (error) {
        this.logger.error("Unable to resume interrupted repository onboarding", error);
      }
    }
    for (const job of listRepositoryOnboardingJobs(this.database, ["queued"])) {
      this.schedule(job.jobId);
    }
    void this.scanConfiguredRepositories();
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const active of this.active.values()) active.abort.abort();
    await Promise.allSettled([...this.active.values()].map((entry) => entry.promise));
  }

  private publicJob(job: RepositoryOnboardingJob): RepositoryOnboarding {
    // Validate the exact wire shape here so malformed adapter/database state
    // fails at the service boundary instead of leaking to Fastify.
    return repositoryOnboardingSchema.parse({
      jobId: job.jobId,
      status: job.status,
      step: job.step,
      detail: job.detail,
      progress: job.progress,
      repositoryId: job.repositoryId,
      githubMetadataPending: job.githubMetadataPending,
      input: repositoryOnboardingInputSchema.parse(job.input),
      error: job.error,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      updatedAt: job.updatedAt,
    });
  }

  private assertNoDuplicate(input: RepositoryOnboardingInput): void {
    const github = input.github.toLocaleLowerCase("en-US");
    const key = input.key.toLocaleLowerCase("en-US");
    const configured = this.config.repositories.find(
      (repository) =>
        repository.key.toLocaleLowerCase("en-US") === key ||
        repository.github.toLocaleLowerCase("en-US") === github,
    );
    if (configured !== undefined) {
      throw new RepositoryOnboardingConflictError(
        `Repository key or GitHub repository is already configured: ${input.key}`,
      );
    }
    const active = listRepositoryOnboardingJobs(this.database, [
      "queued",
      "validating",
      "cloning",
      "registering",
      "initializing",
      "syncing",
    ]).find(
      (job) =>
        job.input.key.toLocaleLowerCase("en-US") === key ||
        job.input.github.toLocaleLowerCase("en-US") === github,
    );
    if (active !== undefined) {
      throw new RepositoryOnboardingConflictError(
        `Repository onboarding is already in progress: ${active.jobId}`,
      );
    }
    // Disabled historical rows remain in the DB and may be restored through
    // system.yaml; do not let a new job silently take their stable identity.
    const existing = getRepository(this.database, input.key);
    if (existing !== null) {
      throw new RepositoryOnboardingConflictError(
        `Repository key is already present in local state: ${input.key}`,
      );
    }
  }

  private schedule(jobId: string): void {
    if (this.closed || this.active.has(jobId)) return;
    const abort = new AbortController();
    const promise = this.process(jobId, abort.signal);
    this.active.set(jobId, { abort, promise });
    void promise.finally(() => {
      if (this.active.get(jobId)?.promise !== promise) return;
      this.active.delete(jobId);
      // A retry can race the final failure/cancellation cleanup. Re-arm a
      // queued job after this worker releases its slot so it cannot remain
      // stranded in the durable queue.
      const current = getRepositoryOnboardingJob(this.database, jobId);
      if (!this.closed && current?.status === "queued") this.schedule(jobId);
    });
  }

  private async process(jobId: string, signal: AbortSignal): Promise<void> {
    try {
      let job = requireRepositoryOnboardingJob(this.database, jobId);
      if (job.status !== "queued") return;
      job = this.updateStep(jobId, "validating", 5, "Validating repository URL and managed path");
      const input = job.input;
      assertManagedRepositoryPath(this.config.runtime.repositoriesPath, input.targetPath, false);
      const gitInput = this.toGitInput(input);
      this.updateStep(jobId, "cloning", 20, "Cloning or adopting repository checkout");
      const verified = await this.ensureCheckout(gitInput, signal, jobId);
      assertVerifiedInspection(verified, input.targetPath);
      if (signal.aborted) throw new RepositoryOnboardingCancelledError();

      job = this.updateStep(jobId, "registering", 55, "Registering repository in system.yaml and SQLite");
      // The requested branch is durable user input. Git verification may
      // report the same branch, but it must never replace the requested value
      // with an adapter-inferred remote default.
      const registration = await this.register(job, input.defaultBranch);
      this.updateRepositoryId(jobId, registration.repositoryId);

      this.updateStep(jobId, "initializing", 70, "Initializing settings, Domain source, and scheduler tasks");
      this.initializeRepository(registration.repositoryId);

      const metadataConfigured = await this.isMetadataCredentialConfigured();
      if (!metadataConfigured) {
        this.updateReady(
          jobId,
          true,
          "Repository initialized; GitHub metadata sync is waiting for credentials",
        );
        return;
      }
      this.updateStep(jobId, "syncing", 88, "Starting initial GitHub metadata sync");
      await this.initialSync(registration.repositoryId);
      this.updateReady(jobId, false, "Repository onboarding completed");
    } catch (error) {
      if (isAbortLike(error) || signal.aborted) {
        const current = getRepositoryOnboardingJob(this.database, jobId);
        if (current !== null && current.status !== "cancelled") {
          try {
            cancelRepositoryOnboardingJob(this.database, jobId);
          } catch (cancelError) {
            // Registration may have advanced the durable state while the
            // cancellation signal was in flight. The cancel route reports
            // that invalid state; the worker must not roll back registration
            // or leave an unhandled rejection here.
            this.logger.error("Repository onboarding cancellation lost a state race", cancelError);
          }
        }
        return;
      }
      const current = getRepositoryOnboardingJob(this.database, jobId);
      if (current === null || current.status === "cancelled") return;
      const sanitized = sanitizeOnboardingError(error);
      try {
        updateRepositoryOnboardingJob(this.database, jobId, {
          status: "failed",
          step: "failed",
          detail: sanitized.message,
          progress: current.progress,
          error: sanitized,
          finishedAt: this.timestamp(),
        });
      } catch (updateError) {
        this.logger.error("Failed to persist repository onboarding error", updateError);
      }
    }
  }

  private updateStep(
    jobId: string,
    status: Extract<RepositoryOnboardingJob["status"], "validating" | "cloning" | "registering" | "initializing" | "syncing">,
    progress: number,
    detail: string,
  ): RepositoryOnboardingJob {
    const current = requireRepositoryOnboardingJob(this.database, jobId);
    if (current.status === "cancelled") throw new RepositoryOnboardingCancelledError();
    return updateRepositoryOnboardingJob(this.database, jobId, {
      status,
      step: status,
      progress,
      detail,
      error: null,
      startedAt: current.startedAt ?? this.timestamp(),
    });
  }

  private updateRepositoryId(jobId: string, repositoryId: string): void {
    updateRepositoryOnboardingJob(this.database, jobId, { repositoryId });
  }

  private updateReady(jobId: string, pending: boolean, detail: string): void {
    updateRepositoryOnboardingJob(this.database, jobId, {
      status: "ready",
      step: "ready",
      progress: 100,
      detail,
      githubMetadataPending: pending,
      error: null,
      finishedAt: this.timestamp(),
    });
  }

  private async ensureCheckout(
    input: GitWorkspaceOnboardingInput,
    signal: AbortSignal,
    jobId: string,
  ): Promise<GitRepositoryInspection | GitRepositoryCloneResult> {
    const result = await this.gitWorkspace.ensure(input, this.gitOptions(signal));
    const current = getRepositoryOnboardingJob(this.database, jobId);
    if (current !== null && current.status !== "cancelled") {
      try {
        updateRepositoryOnboardingJob(this.database, jobId, {
          detail: result.action === "adopted"
            ? "Existing repository checkout adopted"
            : "Repository checkout cloned",
          progress: result.action === "adopted" ? 45 : 40,
        });
      } catch {
        // Progress reporting must not interrupt the Git operation.
      }
    }
    return result;
  }

  private gitOptions(
    signal: AbortSignal,
  ): GitWorkspaceOnboardingOptions {
    return {
      signal,
    };
  }

  private toGitInput(input: RepositoryOnboardingInput): GitWorkspaceOnboardingInput {
    const [owner, name] = input.github.split("/");
    if (owner === undefined || name === undefined) throw new Error(`Invalid GitHub repository: ${input.github}`);
    const credential = this.credentialToken === undefined
      ? undefined
      : async (): Promise<RepositoryCredential | undefined> => {
          // Public repositories must still clone when no GitHub credential is
          // configured. A resolver failure therefore means "no credential"
          // for the Git askpass boundary; metadata status is reported after
          // initialization by credentialSummary.
          let token: string | null;
          try {
            token = await this.credentialToken!();
          } catch {
            token = null;
          }
          return token === null || token.trim().length === 0 ? undefined : { token };
        };
    return {
      cloneUrl: input.cloneUrl,
      owner,
      name,
      remoteName: input.remoteName,
      defaultBranch: input.defaultBranch,
      targetPath: input.targetPath,
      managedRoot: this.config.runtime.repositoriesPath,
      ...(credential === undefined ? {} : { credential }),
    };
  }

  private async register(job: RepositoryOnboardingJob, branch: string): Promise<{ repositoryId: string }> {
    return this.withConfigWriteLock(async () => {
      const input = job.input;
      const previousRepositories = this.config.repositories;
      let previousRaw: string | null = null;
      let configWasWritten = false;
      try {
        const current = this.config.repositories.find(
          (repository) => repository.key.toLocaleLowerCase("en-US") === input.key.toLocaleLowerCase("en-US"),
        );
        if (current !== undefined) {
          if (
            current.github.toLocaleLowerCase("en-US") !== input.github.toLocaleLowerCase("en-US") ||
            resolve(current.path) !== resolve(input.targetPath)
          ) {
            throw new RepositoryOnboardingConflictError(
              `Configured repository identity conflicts with onboarding job: ${input.key}`,
            );
          }
        } else {
          const expectedHash = this.expectedConfigHash(job.configHash);
          const next = appendRepositoryToSystemConfig(this.configPath, expectedHash, {
            key: input.key,
            name: input.displayName,
            github: input.github,
            path: configPathForTarget(this.configPath, input.targetPath),
            remote: input.remoteName,
            defaultBranch: branch,
            worktreeSlots: input.worktreeSlots,
          });
          previousRaw = next.previousRaw;
          configWasWritten = true;
          this.config.repositories = next.config.repositories;
          this.lastWrittenConfigHash = next.nextHash;
        }
        // Keep the in-memory config and persisted projection aligned before any
        // scheduler task is created. Existing rows remain durable projections.
        const repository = this.config.repositories.find(
          (item) => item.key.toLocaleLowerCase("en-US") === input.key.toLocaleLowerCase("en-US"),
        );
        if (repository === undefined) throw new Error(`Repository was not registered: ${input.key}`);
        const reconciled = reconcileRepositories(this.database, this.config.repositories);
        const record = reconciled.find((item) => item.id === input.key);
        if (record === undefined) throw new Error(`Repository projection was not created: ${input.key}`);
        return { repositoryId: record.id };
      } catch (error) {
        if (configWasWritten && previousRaw !== null) {
          try {
            atomicWrite(this.configPath, previousRaw);
            this.config.repositories = previousRepositories;
            this.lastWrittenConfigHash = hashRaw(previousRaw);
          } catch (rollbackError) {
            this.logger.error("Unable to roll back system.yaml after repository registration failure", rollbackError);
          }
        }
        throw error;
      }
    });
  }

  private expectedConfigHash(jobHash: string): string {
    const currentHash = hashFile(this.configPath);
    if (currentHash === jobHash || currentHash === this.lastWrittenConfigHash) return currentHash;
    throw new RepositoryOnboardingConflictError(
      "system.yaml changed while repository onboarding was running; retry to review the new configuration",
    );
  }

  /** Refresh a retry's optimistic YAML guard only after validating its identity. */
  private refreshConfigForRetry(job: RepositoryOnboardingJob): string {
    const raw = readFileSync(this.configPath, "utf8");
    let latest: SystemConfig;
    try {
      latest = parseSystemConfig(parseYaml(raw) as unknown, this.configPath);
    } catch (error) {
      throw new RepositoryOnboardingConflictError(
        error instanceof Error && error.message.trim().length > 0
          ? `Current system.yaml is invalid: ${error.message}`
          : "Current system.yaml is invalid; retry after fixing it",
      );
    }
    const key = job.input.key.toLocaleLowerCase("en-US");
    const github = job.input.github.toLocaleLowerCase("en-US");
    const targetPath = resolve(job.input.targetPath);
    for (const repository of latest.repositories) {
      const sameKey = repository.key.toLocaleLowerCase("en-US") === key;
      const sameGithub = repository.github.toLocaleLowerCase("en-US") === github;
      const samePath = resolve(repository.path) === targetPath;
      if (!sameKey && !sameGithub && !samePath) continue;
      if (!sameKey || !sameGithub || !samePath) {
        throw new RepositoryOnboardingConflictError(
          "system.yaml repository key, GitHub identity, or path conflicts with this onboarding job",
        );
      }
    }
    try {
      assertManagedRepositoryPath(latest.runtime.repositoriesPath, targetPath, false);
    } catch (error) {
      throw new RepositoryOnboardingConflictError(
        error instanceof Error && error.message.trim().length > 0
          ? `Onboarding target conflicts with the current managed root: ${error.message}`
          : "Onboarding target conflicts with the current managed root",
      );
    }
    // Preserve the shared config object used by scheduler/projectors while
    // adopting the latest parsed YAML for registration and future scans.
    Object.assign(this.config, latest);
    // A matching configured row is valid only when its identity/path match;
    // branch and remote are intentionally not part of this retry conflict so
    // a pre-registration job may repair a bad branch through the request body.
    return hashRaw(raw);
  }

  private async withConfigWriteLock<T>(operation: () => T | Promise<T>): Promise<T> {
    const previous = this.configWriteMutex;
    let release!: () => void;
    this.configWriteMutex = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private initializeRepository(repositoryId: string): void {
    const repository = getRepository(this.database, repositoryId);
    if (repository === null) throw new Error(`Repository is missing or disabled: ${repositoryId}`);
    const settings = this.settings?.repositorySettingsSync(repositoryId);
    if (settings === undefined) throw new Error("Repository settings service is not configured");
    if (this.domainFiles === undefined) throw new Error("Domain file service is not configured");
    this.domainFiles.refresh(repositoryId);
    if (this.projector === undefined) throw new Error("System schedule projector is not configured");
    const schedulePolicy = {
      automaticSync: settings.automaticSync,
      syncCron: settings.syncCron,
      retention: settings.retention,
    };
    this.projector.projectRepository(repository, schedulePolicy);
  }

  private async initialSync(repositoryId: string): Promise<void> {
    if (this.syncCoordinator === undefined) {
      throw new Error("Repository sync coordinator is not configured");
    }
    const run = this.syncCoordinator.start(repositoryId, "system");
    const wait = this.syncCoordinator.waitForRun;
    if (wait === undefined) return;
    const result = await wait.call(this.syncCoordinator, run.syncRunId);
    if (result.status === "failed" || result.status === "partial" || result.status === "interrupted") {
      throw new Error(result.error ?? `Initial metadata sync failed for ${repositoryId}`);
    }
  }

  private async isMetadataCredentialConfigured(): Promise<boolean> {
    if (this.credentialSummary === undefined) return true;
    const summary = await this.credentialSummary();
    return summary.configured;
  }

  private async scanConfiguredRepositories(): Promise<void> {
    for (const repository of this.config.repositories) {
      if (this.closed || !isManagedRepositoryPath(this.config.runtime.repositoriesPath, repository.path)) {
        continue;
      }
      let inspection: GitRepositoryInspection | null;
      try {
        inspection = await this.gitWorkspace.inspect(
          this.toGitInput({
            github: repository.github,
            cloneUrl: canonicalCloneUrl(repository.github),
            key: repository.key,
            displayName: repository.name,
            remoteName: repository.remote,
            defaultBranch: repository.defaultBranch,
            targetPath: repository.path,
            worktreeSlots: repository.worktreeSlots,
          }),
        );
      } catch {
        inspection = null;
      }
      if (inspection !== null) continue;
      const existing = listRepositoryOnboardingJobs(this.database).filter(
        (job) =>
          job.input.key.toLocaleLowerCase("en-US") === repository.key.toLocaleLowerCase("en-US") &&
          job.input.github.toLocaleLowerCase("en-US") === repository.github.toLocaleLowerCase("en-US"),
      ).sort(compareOnboardingJobs)[0];
      if (existing !== undefined) {
        if (existing.status === "cancelled") {
          // Cancellation is an explicit user decision and survives restart.
          continue;
        }
        if (
          existing.status === "queued" ||
          existing.status === "validating" ||
          existing.status === "cloning" ||
          existing.status === "registering" ||
          existing.status === "initializing" ||
          existing.status === "syncing"
        ) {
          this.schedule(existing.jobId);
          continue;
        }
        if (existing.status === "failed" || existing.status === "ready") {
          try {
            const configHash = this.refreshConfigForRetry(existing);
            const recovered = retryRepositoryOnboardingJob(
              this.database,
              existing.jobId,
              this.timestamp(),
              { allowReady: true, configHash },
            );
            this.schedule(recovered.jobId);
          } catch (error) {
            this.logger.error("Unable to requeue configured repository onboarding", error);
          }
        }
        continue;
      }
      try {
        const input = repositoryOnboardingInputSchema.parse({
          github: repository.github,
          cloneUrl: canonicalCloneUrl(repository.github),
          key: repository.key,
          displayName: repository.name,
          remoteName: repository.remote,
          defaultBranch: repository.defaultBranch,
          targetPath: resolve(repository.path),
          worktreeSlots: Math.min(16, Math.max(1, repository.worktreeSlots)),
        });
        const job = createRepositoryOnboardingJob(this.database, {
          input,
          configHash: hashFile(this.configPath),
          detail: "Configured repository checkout is missing; queued for initialization",
          now: this.timestamp(),
        });
        this.schedule(job.jobId);
      } catch (error) {
        this.logger.error("Unable to enqueue configured repository onboarding", error);
      }
    }
  }

  private timestamp(): string {
    const now = this.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error("Repository onboarding clock returned an invalid Date");
    }
    return now.toISOString();
  }
}

export class RepositoryOnboardingCancelledError extends Error {
  constructor() {
    super("Repository onboarding was cancelled");
    this.name = "RepositoryOnboardingCancelledError";
  }
}

export function normalizeRepositoryOnboardingInput(
  request: RepositoryOnboardingCreate,
  managedRoot: string,
): RepositoryOnboardingInput {
  const parsed = parseGithubRepositoryUrl(request.url);
  const key = request.key === undefined
    ? normalizeRepositoryKey(`${parsed.owner}-${parsed.name}`)
    : normalizeRepositoryKey(request.key);
  const displayName = request.displayName ?? parsed.name;
  const targetPath = resolve(managedRoot, key);
  assertManagedRepositoryPath(managedRoot, targetPath, true);
  return repositoryOnboardingInputSchema.parse({
    github: `${parsed.owner}/${parsed.name}`,
    cloneUrl: `https://github.com/${parsed.owner}/${parsed.name}.git`,
    key,
    displayName,
    remoteName: request.remote ?? DEFAULT_REMOTE,
    defaultBranch: request.defaultBranch ?? DEFAULT_BRANCH,
    targetPath,
    worktreeSlots: request.worktreeSlots ?? DEFAULT_WORKTREE_SLOTS,
  });
}

export function parseGithubRepositoryUrl(raw: string): { owner: string; name: string } {
  const value = raw.trim();
  let owner: string | undefined;
  let name: string | undefined;
  const ssh = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(value);
  if (ssh !== null) {
    owner = ssh[1];
    name = ssh[2];
  } else if (/^[^/:\s]+\/[^/\s]+$/.test(value)) {
    [owner, name] = value.split("/");
    name = name?.replace(/\.git$/i, "");
  } else {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new InvalidRequestError("Repository URL must be a GitHub https URL, SSH URL, or owner/repo");
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname.toLocaleLowerCase("en-US") !== "github.com" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.port !== "" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      throw new InvalidRequestError("Repository URL must point to github.com over https");
    }
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length !== 2) {
      throw new InvalidRequestError("Repository URL must contain exactly owner/repo");
    }
    owner = parts[0];
    name = parts[1]?.replace(/\.git$/i, "");
  }
  if (
    owner === undefined ||
    name === undefined ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(owner) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) ||
    owner === "." || owner === ".." || name === "." || name === ".."
  ) {
    throw new InvalidRequestError("Repository URL contains an invalid GitHub owner or repository name");
  }
  return {
    owner: owner.toLocaleLowerCase("en-US"),
    name: name.toLocaleLowerCase("en-US"),
  };
}

export function normalizeRepositoryKey(raw: string): string {
  const key = raw.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key) || key === "." || key === "..") {
    throw new InvalidRequestError("Repository key must contain only letters, numbers, dot, underscore, or hyphen");
  }
  return key;
}

export function canonicalCloneUrl(github: string): string {
  const [owner, name] = github.split("/");
  if (owner === undefined || name === undefined) throw new Error(`Invalid GitHub repository: ${github}`);
  return `https://github.com/${owner.toLocaleLowerCase("en-US")}/${name.toLocaleLowerCase("en-US")}.git`;
}

function assertVerifiedInspection(
  inspection: GitRepositoryInspection | GitRepositoryCloneResult,
  targetPath: string,
): void {
  if (inspection.remoteMatched !== true) {
    throw new Error(`Git remote does not match the requested repository for ${targetPath}`);
  }
  if (inspection.defaultBranchAvailable !== true) {
    throw new Error(`Configured default branch is unavailable for ${targetPath}`);
  }
}

function isManagedRepositoryPath(root: string, target: string): boolean {
  try {
    assertManagedRepositoryPath(root, target, false);
    return true;
  } catch {
    return false;
  }
}

/** Reject path traversal and symlink escape before handing the path to Git. */
export function assertManagedRepositoryPath(
  managedRoot: string,
  targetPath: string,
  createRoot: boolean,
): void {
  const root = resolve(managedRoot);
  const target = resolve(targetPath);
  const logicalRelative = relative(root, target);
  if (
    logicalRelative.length === 0 ||
    logicalRelative === ".." ||
    logicalRelative.startsWith(`..${sep}`) ||
    isAbsolute(logicalRelative)
  ) {
    throw new InvalidRequestError("Repository target path must stay inside runtime.repositoriesPath");
  }
  if (!existsSync(root)) {
    if (!createRoot) return;
    mkdirSync(root, { recursive: true });
  }
  if (lstatSync(root).isSymbolicLink()) {
    throw new InvalidRequestError("runtime.repositoriesPath must not be a symbolic link");
  }
  const canonicalRoot = realpathSync(root);
  if (existsSync(target)) {
    const targetStat = lstatSync(target);
    if (targetStat.isSymbolicLink()) {
      throw new InvalidRequestError("Repository target path must not be a symbolic link");
    }
    const canonicalTarget = realpathSync(target);
    if (!isWithinRoot(canonicalRoot, canonicalTarget)) {
      throw new InvalidRequestError("Repository target path escapes runtime.repositoriesPath");
    }
    return;
  }
  let ancestor = dirname(target);
  while (!existsSync(ancestor) && ancestor !== dirname(ancestor)) ancestor = dirname(ancestor);
  if (existsSync(ancestor) && !isWithinRoot(canonicalRoot, realpathSync(ancestor))) {
    throw new InvalidRequestError("Repository target parent escapes runtime.repositoriesPath");
  }
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function configPathForTarget(configPath: string, targetPath: string): string {
  const configDirectory = dirname(resolve(configPath));
  const target = resolve(targetPath);
  const path = relative(configDirectory, target);
  return path.length === 0 || path.startsWith(`..${sep}`) || isAbsolute(path)
    ? target
    : `.${sep}${path}`;
}

function appendRepositoryToSystemConfig(
  configPath: string,
  expectedHash: string,
  repository: {
    key: string;
    name: string;
    github: string;
    path: string;
    remote: string;
    defaultBranch: string;
    worktreeSlots: number;
  },
): { config: SystemConfig; previousRaw: string; nextHash: string } {
  const currentRaw = readFileSync(configPath, "utf8");
  const currentHash = createHash("sha256").update(currentRaw).digest("hex");
  if (currentHash !== expectedHash) {
    throw new RepositoryOnboardingConflictError(
      "system.yaml changed while repository onboarding was running; retry to review the new configuration",
    );
  }
  const document = parseDocument(currentRaw);
  if (document.errors.length > 0) {
    throw new Error("system.yaml is invalid and cannot be updated safely");
  }
  const repositories = document.get("repositories", true) as { items?: unknown[] } | null;
  if (repositories === null || !Array.isArray(repositories.items)) {
    throw new Error("system.yaml.repositories must be a YAML sequence");
  }
  const duplicate = repositories.items.some((item) => {
    if (item === null || typeof item !== "object") return false;
    const value = item as { get?: (key: string) => unknown };
    const key = value.get?.("key");
    const github = value.get?.("github");
    return (
      (typeof key === "string" && key.toLocaleLowerCase("en-US") === repository.key.toLocaleLowerCase("en-US")) ||
      (typeof github === "string" && github.toLocaleLowerCase("en-US") === repository.github.toLocaleLowerCase("en-US"))
    );
  });
  if (duplicate) throw new RepositoryOnboardingConflictError("Repository key or GitHub repository is already configured");
  repositories.items.push(document.createNode(repository));
  const nextRaw = String(document);
  const nextInput = parseYaml(nextRaw) as unknown;
  const nextConfig = parseSystemConfig(nextInput, configPath);
  ensureRegularFile(configPath);
  atomicWrite(configPath, nextRaw);
  return {
    config: nextConfig,
    previousRaw: currentRaw,
    nextHash: hashRaw(nextRaw),
  };
}

function sanitizeOnboardingError(error: unknown): { code: string; message: string; retryable: boolean } {
  const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "REPOSITORY_ONBOARDING_FAILED";
  let message = error instanceof Error ? error.message : String(error);
  message = message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(?:ghp_|github_pat_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9_]+/g, "[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "[redacted]")
    .slice(0, 2_000);
  return { code, message: message.trim() || "Repository onboarding failed", retryable: true };
}

function isAbortLike(error: unknown): boolean {
  return error instanceof RepositoryOnboardingCancelledError ||
    (error instanceof Error && (error.name === "AbortError" || error.message.toLowerCase().includes("aborted")));
}

function ensureRegularFile(path: string): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error("system.yaml must not be a symbolic link");
  }
}

function ensureManagedRoot(path: string): void {
  const root = resolve(path);
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) {
    throw new InvalidRequestError("runtime.repositoriesPath must be a regular directory");
  }
}

function hashRaw(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function compareOnboardingJobs(left: RepositoryOnboardingJob, right: RepositoryOnboardingJob): number {
  const updated = right.updatedAt.localeCompare(left.updatedAt);
  return updated !== 0 ? updated : right.createdAt.localeCompare(left.createdAt);
}
