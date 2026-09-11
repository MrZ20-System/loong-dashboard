import {
  completeSyncRunStream,
  failSyncRunStream,
  getRepositoryHistoryState,
  recordSyncRunPage,
  updateRepositoryHistoryState,
  upsertIssuePage,
  upsertPullRequestPage,
  type DatabaseClient,
  type EntityKind,
  type RepositoryHistoryState,
  type RepositoryRecord,
  type SyncRun,
} from "@loongboard/database";
import type {
  GitHubMetadataProvider,
  GitHubRateLimit,
  HistorySyncInput,
  IssuePage,
  PullRequestPage,
} from "@loongboard/github";

const HISTORY_RATE_LIMIT_FLOOR = 200;

export interface HistorySyncJob {
  readonly kind: "history";
  readonly run: SyncRun;
  readonly repository: RepositoryRecord;
  readonly targetDate: string | null;
  readonly pullRequestState: RepositoryHistoryState;
  readonly issueState: RepositoryHistoryState;
  readonly pullRequestOldestObserved: { value: string | null };
  readonly issueOldestObserved: { value: string | null };
  readonly pageBudget: number;
  readonly pullRequestNeedsWork: boolean;
  readonly issueNeedsWork: boolean;
}

interface HistorySyncRunnerLogger {
  error(...arguments_: readonly unknown[]): void;
}

export interface HistorySyncRunnerOptions {
  readonly database: DatabaseClient;
  readonly provider: GitHubMetadataProvider;
  readonly logger: HistorySyncRunnerLogger;
  readonly timestamp: () => string;
  readonly calendarDay: (value: Date | string) => string;
}

/** Consumes bounded history pages and records durable cursor progress. */
export class HistorySyncRunner {
  constructor(private readonly options: HistorySyncRunnerOptions) {}

  async run(job: HistorySyncJob): Promise<void> {
    await Promise.all([
      this.consumePullRequests(job),
      this.consumeIssues(job),
    ]);
  }

  recordUnexpectedFailure(job: HistorySyncJob, error: unknown): void {
    this.failStream(job, "pull_request", error);
    this.failStream(job, "issue", error);
  }

  private async consumePullRequests(job: HistorySyncJob): Promise<void> {
    try {
      if (!job.pullRequestNeedsWork) {
        completeSyncRunStream(this.options.database, job.run.syncRunId, "pull_request", {
          finishedAt: this.options.timestamp(),
          watermarkAfter: null,
        });
        return;
      }
      if (this.options.provider.fetchPullRequestHistory === undefined) {
        throw new Error("GitHub provider does not support durable pull request history pagination");
      }
      let latestRateLimit: GitHubRateLimit | undefined;
      const input: HistorySyncInput = {
        repository: toRepositoryRef(job.repository),
        cursor: job.pullRequestState.cursor,
        recoveryAnchorUpdatedAt: job.pullRequestState.recoveryAnchorUpdatedAt,
        syncStartedAt: this.options.timestamp(),
      };
      let pagesFetched = 0;
      let targetReached = false;
      let hasMore = false;
      let rateFloorReached = false;
      for await (const page of this.options.provider.fetchPullRequestHistory(input)) {
        pagesFetched += 1;
        hasMore = page.pageInfo.hasNextPage;
        const written = this.persistPullRequestPage(job, page);
        recordSyncRunPage(this.options.database, job.run.syncRunId, {
          entityKind: "pull_request",
          itemsSeen: page.items.length,
          itemsWritten: written,
          rateLimitRemaining: page.rateLimit.remaining,
        });
        latestRateLimit = page.rateLimit;
        this.persistProgress(job, "pull_request", page);
        targetReached = this.reachedTarget(job, job.pullRequestOldestObserved.value);
        rateFloorReached = page.rateLimit.remaining < HISTORY_RATE_LIMIT_FLOOR;
        if (targetReached || pagesFetched >= job.pageBudget || rateFloorReached) break;
      }
      await this.finishStream(
        job,
        "pull_request",
        latestRateLimit,
        targetReached || (!hasMore && !rateFloorReached),
      );
    } catch (error: unknown) {
      this.failStream(job, "pull_request", error);
    }
  }

  private async consumeIssues(job: HistorySyncJob): Promise<void> {
    try {
      if (!job.issueNeedsWork) {
        completeSyncRunStream(this.options.database, job.run.syncRunId, "issue", {
          finishedAt: this.options.timestamp(),
          watermarkAfter: null,
        });
        return;
      }
      if (this.options.provider.fetchIssueHistory === undefined) {
        throw new Error("GitHub provider does not support durable issue history pagination");
      }
      let latestRateLimit: GitHubRateLimit | undefined;
      const input: HistorySyncInput = {
        repository: toRepositoryRef(job.repository),
        cursor: job.issueState.cursor,
        recoveryAnchorUpdatedAt: job.issueState.recoveryAnchorUpdatedAt,
        syncStartedAt: this.options.timestamp(),
      };
      let pagesFetched = 0;
      let targetReached = false;
      let hasMore = false;
      let rateFloorReached = false;
      for await (const page of this.options.provider.fetchIssueHistory(input)) {
        pagesFetched += 1;
        hasMore = page.pageInfo.hasNextPage;
        const written = upsertIssuePage(this.options.database, job.repository.id, page.items);
        recordSyncRunPage(this.options.database, job.run.syncRunId, {
          entityKind: "issue",
          itemsSeen: page.items.length,
          itemsWritten: written,
          rateLimitRemaining: page.rateLimit.remaining,
        });
        latestRateLimit = page.rateLimit;
        this.persistProgress(job, "issue", page);
        targetReached = this.reachedTarget(job, job.issueOldestObserved.value);
        rateFloorReached = page.rateLimit.remaining < HISTORY_RATE_LIMIT_FLOOR;
        if (targetReached || pagesFetched >= job.pageBudget || rateFloorReached) break;
      }
      await this.finishStream(
        job,
        "issue",
        latestRateLimit,
        targetReached || (!hasMore && !rateFloorReached),
      );
    } catch (error: unknown) {
      this.failStream(job, "issue", error);
    }
  }

  private persistPullRequestPage(job: HistorySyncJob, page: PullRequestPage): number {
    // History only expands current metadata coverage. It does not create
    // enrichment targets or call lifecycle/timeline APIs.
    return upsertPullRequestPage(this.options.database, job.repository.id, page.items);
  }

  private persistProgress(
    job: HistorySyncJob,
    entityKind: EntityKind,
    page: PullRequestPage | IssuePage,
  ): void {
    const oldest = page.items.at(-1);
    const oldestDay = oldest === undefined ? null : this.options.calendarDay(oldest.updatedAt);
    const state = entityKind === "pull_request" ? job.pullRequestState : job.issueState;
    const oldestHolder = entityKind === "pull_request"
      ? job.pullRequestOldestObserved
      : job.issueOldestObserved;
    if (oldestDay !== null && (oldestHolder.value === null || oldestDay < oldestHolder.value)) {
      oldestHolder.value = oldestDay;
    }
    const nextCursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    updateRepositoryHistoryState(this.options.database, job.repository.id, entityKind, {
      cursor: nextCursor,
      recoveryAnchorUpdatedAt: oldest?.updatedAt ?? state.recoveryAnchorUpdatedAt,
      lastRunId: job.run.syncRunId,
      lastError: null,
    });
  }

  private async finishStream(
    job: HistorySyncJob,
    entityKind: EntityKind,
    rateLimit: GitHubRateLimit | undefined,
    completed: boolean,
  ): Promise<void> {
    const state = getRepositoryHistoryState(this.options.database, job.repository.id, entityKind);
    const oldest = entityKind === "pull_request"
      ? job.pullRequestOldestObserved.value
      : job.issueOldestObserved.value;
    const paused = state.status === "paused";
    const rateLimitPaused =
      !completed &&
      !paused &&
      state.enabled &&
      state.cursor !== null &&
      rateLimit !== undefined &&
      rateLimit.remaining < HISTORY_RATE_LIMIT_FLOOR &&
      Number.isFinite(Date.parse(rateLimit.resetAt));
    const canContinue =
      !completed &&
      !paused &&
      state.enabled &&
      state.cursor !== null &&
      !rateLimitPaused;
    if (state.cursor === null || completed) {
      const boundary = oldest ?? this.options.calendarDay(this.options.timestamp());
      const target = job.targetDate ?? boundary;
      updateRepositoryHistoryState(this.options.database, job.repository.id, entityKind, {
        oldestCoveredDay: target,
        status: paused ? "paused" : completed || target <= boundary ? "completed" : "idle",
        resumeAfter: null,
      });
    } else {
      updateRepositoryHistoryState(this.options.database, job.repository.id, entityKind, {
        // A low-watermark page is a durable pause, not a provider error. No
        // continuation is admitted until the provider's reset timestamp.
        status: canContinue ? "running" : paused ? "paused" : "idle",
        resumeAfter: rateLimitPaused ? rateLimit!.resetAt : null,
      });
    }
    completeSyncRunStream(this.options.database, job.run.syncRunId, entityKind, {
      finishedAt: this.options.timestamp(),
      rateLimitRemaining: rateLimit?.remaining,
      watermarkAfter: null,
      status: completed ? "completed" : "partial",
    });
  }

  private failStream(job: HistorySyncJob, entityKind: EntityKind, error: unknown): void {
    try {
      updateRepositoryHistoryState(this.options.database, job.repository.id, entityKind, {
        status: "failed",
        lastError: error instanceof Error ? error.message : String(error),
        lastRunId: job.run.syncRunId,
      });
      failSyncRunStream(
        this.options.database,
        job.run.syncRunId,
        entityKind,
        error,
        this.options.timestamp(),
      );
    } catch (failure: unknown) {
      this.logError("Unable to record history sync failure", failure, {
        repositoryId: job.repository.id,
        entityKind,
      });
    }
  }

  private reachedTarget(job: HistorySyncJob, oldestDay: string | null): boolean {
    return job.targetDate !== null && oldestDay !== null && oldestDay <= job.targetDate;
  }

  private logError(message: string, error: unknown, context: Record<string, string>): void {
    this.options.logger.error(message, error, context);
  }
}

function toRepositoryRef(repository: RepositoryRecord): { owner: string; name: string } {
  return { owner: repository.githubOwner, name: repository.githubName };
}
