import {
  completeSyncStream,
  failSyncStream,
  getRepository,
  getRepositorySyncState,
  startRepositorySync,
  upsertIssuePage,
  upsertPullRequestPage,
  type DatabaseClient,
  type EntityKind,
  type RepositoryRecord,
  type RepositorySyncState,
  type SyncRun,
} from "@loongboard/database";
import type {
  GitHubMetadataProvider,
  GitHubRateLimit,
  IssuePage,
  IssueSyncInput,
  PullRequestPage,
  PullRequestSyncInput,
} from "@loongboard/github";

import type { PullRequestFileEnricher } from "./enrichment-service.js";

const DEFAULT_MAX_CONCURRENT_REPOSITORIES = 2;

export interface SyncCoordinatorLogger {
  error(...arguments_: readonly unknown[]): void;
}

export interface RepositorySyncCoordinatorOptions {
  database: DatabaseClient;
  provider: GitHubMetadataProvider;
  maxConcurrentRepositories?: number;
  lookbackDays?: number;
  /** Resolve the configured initial/bootstrap metadata window for each run. */
  lookbackDaysForRepository?: (repositoryId: string) => number;
  now?: () => Date;
  logger?: SyncCoordinatorLogger;
  /**
   * Changed-file enrichment run after a successful PR metadata stream
   * (plan 9.6). Optional so metadata-only embedders stay valid; enrichment
   * failures are logged and never fail the metadata stream (plan 9.9).
   */
  enricher?: PullRequestFileEnricher;
}

/** The narrow dependency consumed by the HTTP application factory. */
export interface SyncCoordinator {
  start(repositoryId: string): SyncRun;
  waitForIdle(): Promise<void>;
  close(): Promise<void>;
}

interface RepositorySyncJob {
  readonly run: SyncRun;
  readonly repository: RepositoryRecord;
  readonly pullRequestState: RepositorySyncState;
  readonly issueState: RepositorySyncState;
  readonly lookbackDays: number | undefined;
}

/**
 * A small FIFO semaphore used to enforce the V1 global repository budget.
 * The permit covers both metadata streams for one repository, so a repository
 * cannot consume two of the two available repository slots.
 */
class RepositoryConcurrencyLimiter {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly maximum: number) {}

  get activeCount(): number {
    return this.active;
  }

  get maximumCount(): number {
    return this.maximum;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.maximum) {
      this.active += 1;
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next !== undefined) next();
  }
}

/**
 * Coordinates one background metadata sync per repository. Provider failures
 * are recorded per entity stream, while already persisted rows and successful
 * watermarks remain untouched by the failed stream.
 */
export class RepositorySyncCoordinator implements SyncCoordinator {
  private readonly database: DatabaseClient;
  private readonly provider: GitHubMetadataProvider;
  private readonly limiter: RepositoryConcurrencyLimiter;
  private readonly lookbackDays: number | undefined;
  private readonly lookbackDaysForRepository:
    | ((repositoryId: string) => number)
    | undefined;
  private readonly now: () => Date;
  private readonly logger: SyncCoordinatorLogger;
  private readonly enricher: PullRequestFileEnricher | undefined;
  private readonly pending = new Set<Promise<void>>();
  private closed = false;

  constructor(options: RepositorySyncCoordinatorOptions) {
    const maximum =
      options.maxConcurrentRepositories ?? DEFAULT_MAX_CONCURRENT_REPOSITORIES;
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 2) {
      throw new Error(
        "maxConcurrentRepositories must be an integer between 1 and 2",
      );
    }
    if (
      options.lookbackDays !== undefined &&
      (!Number.isInteger(options.lookbackDays) || options.lookbackDays <= 0)
    ) {
      throw new Error("lookbackDays must be a positive integer");
    }

    this.database = options.database;
    this.provider = options.provider;
    this.limiter = new RepositoryConcurrencyLimiter(maximum);
    this.lookbackDays = options.lookbackDays;
    this.lookbackDaysForRepository = options.lookbackDaysForRepository;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? console;
    this.enricher = options.enricher;
  }

  get activeRepositoryCount(): number {
    return this.limiter.activeCount;
  }

  get maxConcurrentRepositories(): number {
    return this.limiter.maximumCount;
  }

  /**
   * Atomically marks both entity streams running and schedules the actual
   * provider work. This method intentionally returns before any GitHub call.
   */
  start(repositoryId: string): SyncRun {
    if (this.closed) throw new Error("Cannot start a sync after coordinator close");

    const repository = getRepository(this.database, repositoryId);
    if (repository === null) {
      // startRepositorySync performs the canonical RepositoryNotFoundError
      // conversion; calling it here keeps this boundary consistent.
      return startRepositorySync(this.database, repositoryId);
    }

    // Read watermarks before startRepositorySync changes the stream status.
    // Both streams receive one shared attempt timestamp below.
    const pullRequestState = getRepositorySyncState(
      this.database,
      repositoryId,
      "pull_request",
    );
    const issueState = getRepositorySyncState(
      this.database,
      repositoryId,
      "issue",
    );
    const lookbackDays = this.resolveLookbackDays(repositoryId);
    const startedAt = this.timestamp();
    const run = startRepositorySync(this.database, repositoryId, startedAt);

    this.schedule({
      run,
      repository,
      pullRequestState,
      issueState,
      lookbackDays,
    });
    return run;
  }

  async waitForIdle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.waitForIdle();
  }

  private schedule(job: RepositorySyncJob): void {
    const task = this.limiter
      .run(() => this.execute(job))
      .catch((error: unknown) => {
        this.recordUnexpectedFailure(job, error);
      });
    this.pending.add(task);
    task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );
  }

  private async execute(job: RepositorySyncJob): Promise<void> {
    // Each entity owns its own failure transition. Promise.all therefore
    // waits for both streams without allowing one provider failure to cancel
    // the other stream.
    await Promise.all([
      this.consumePullRequests(job),
      this.consumeIssues(job),
    ]);
  }

  private async consumePullRequests(job: RepositorySyncJob): Promise<void> {
    try {
      let latestRateLimit: GitHubRateLimit | undefined;
      const input: PullRequestSyncInput = {
        repository: toRepositoryRef(job.repository),
        mode: syncMode(job.pullRequestState),
        watermarkUpdatedAt: job.pullRequestState.watermarkUpdatedAt,
        syncStartedAt: job.run.startedAt,
        ...(job.lookbackDays === undefined
          ? {}
          : { lookbackDays: job.lookbackDays }),
      };

      for await (const page of this.provider.fetchPullRequestUpdates(input)) {
        this.persistPullRequestPage(job, page);
        latestRateLimit = page.rateLimit;
      }

      this.complete(job, "pull_request", latestRateLimit);
      await this.enrichPullRequestFiles(job, latestRateLimit);
    } catch (error: unknown) {
      this.fail(job, "pull_request", error);
    }
  }

  /**
   * Plan 9.6/9.9: enrichment runs after the metadata stream succeeded; its
   * failure is logged and never transitions the completed stream to failed.
   */
  private async enrichPullRequestFiles(
    job: RepositorySyncJob,
    rateLimit: GitHubRateLimit | undefined,
  ): Promise<void> {
    if (this.enricher === undefined) return;
    try {
      await this.enricher.enrich(job.repository, rateLimit);
    } catch (error: unknown) {
      this.logError("Pull request file enrichment failed", error, {
        repositoryId: job.repository.id,
      });
    }
  }

  private async consumeIssues(job: RepositorySyncJob): Promise<void> {
    try {
      let latestRateLimit: GitHubRateLimit | undefined;
      const input: IssueSyncInput = {
        repository: toRepositoryRef(job.repository),
        mode: syncMode(job.issueState),
        watermarkUpdatedAt: job.issueState.watermarkUpdatedAt,
        syncStartedAt: job.run.startedAt,
        ...(job.lookbackDays === undefined
          ? {}
          : { lookbackDays: job.lookbackDays }),
      };

      for await (const page of this.provider.fetchIssueUpdates(input)) {
        this.persistIssuePage(job, page);
        latestRateLimit = page.rateLimit;
      }

      this.complete(job, "issue", latestRateLimit);
    } catch (error: unknown) {
      this.fail(job, "issue", error);
    }
  }

  private persistPullRequestPage(
    job: RepositorySyncJob,
    page: PullRequestPage,
  ): void {
    upsertPullRequestPage(this.database, job.repository.id, page.items);
  }

  private persistIssuePage(job: RepositorySyncJob, page: IssuePage): void {
    upsertIssuePage(this.database, job.repository.id, page.items);
  }

  private complete(
    job: RepositorySyncJob,
    entityKind: EntityKind,
    rateLimit: GitHubRateLimit | undefined,
  ): void {
    completeSyncStream(this.database, {
      repositoryId: job.repository.id,
      entityKind,
      completedAt: this.timestamp(),
      rateLimitRemaining: rateLimit?.remaining,
      rateLimitResetAt: rateLimit?.resetAt,
    });
  }

  private fail(job: RepositorySyncJob, entityKind: EntityKind, error: unknown): void {
    try {
      failSyncStream(this.database, {
        repositoryId: job.repository.id,
        entityKind,
        error,
        failedAt: this.timestamp(),
      });
    } catch (failure: unknown) {
      this.logError("Unable to record metadata sync failure", failure, {
        repositoryId: job.repository.id,
        entityKind,
      });
    }
  }

  private recordUnexpectedFailure(job: RepositorySyncJob, error: unknown): void {
    this.logError("Unexpected metadata sync failure", error, {
      repositoryId: job.repository.id,
    });
    for (const entityKind of ["pull_request", "issue"] as const) {
      this.fail(job, entityKind, error);
    }
  }

  private logError(
    message: string,
    error: unknown,
    context: Record<string, string>,
  ): void {
    this.logger.error(message, error, context);
  }

  private timestamp(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new Error("Sync coordinator clock returned an invalid Date");
    }
    return value.toISOString();
  }

  private resolveLookbackDays(repositoryId: string): number | undefined {
    const value = this.lookbackDaysForRepository?.(repositoryId) ?? this.lookbackDays;
    if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
      throw new Error("lookbackDays must be a positive integer");
    }
    return value;
  }
}

function syncMode(state: RepositorySyncState): "bootstrap" | "incremental" {
  return state.watermarkUpdatedAt === null ? "bootstrap" : "incremental";
}

function toRepositoryRef(repository: RepositoryRecord): {
  owner: string;
  name: string;
} {
  return {
    owner: repository.githubOwner,
    name: repository.githubName,
  };
}
