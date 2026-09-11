import {
  completeSyncRunStream,
  completeSyncStream,
  failSyncRunStream,
  failSyncStream,
  listCurrentPullRequestEnrichmentStates,
  recordSyncRunPage,
  recordSyncRunTarget,
  upsertIssuePage,
  upsertPullRequestPage,
  type DatabaseClient,
  type PullRequestEnrichmentTarget,
  type RepositoryRecord,
  type RepositorySyncState,
  type SyncRun,
} from "@loongboard/database";
import type {
  GitHubMetadataProvider,
  GitHubRateLimit,
  IssueSyncInput,
  PullRequestMetadata,
  PullRequestPage,
  PullRequestSyncInput,
} from "@loongboard/github";

export interface ForwardSyncJob {
  readonly kind: "forward";
  readonly run: SyncRun;
  readonly repository: RepositoryRecord;
  readonly pullRequestState: RepositorySyncState;
  readonly issueState: RepositorySyncState;
  readonly lookbackDays: number | undefined;
  readonly targetNumbers: Map<number, PullRequestEnrichmentTarget>;
}

interface ForwardSyncRunnerLogger {
  error(...arguments_: readonly unknown[]): void;
}

export interface ForwardSyncRunnerOptions {
  readonly database: DatabaseClient;
  readonly provider: GitHubMetadataProvider;
  readonly logger: ForwardSyncRunnerLogger;
  readonly timestamp: () => string;
  readonly enrichPullRequestFiles: (
    repository: RepositoryRecord,
    rateLimit: GitHubRateLimit | undefined,
    targets: readonly PullRequestEnrichmentTarget[],
  ) => Promise<void>;
}

/** Consumes forward metadata pages and records each stream's durable result. */
export class ForwardSyncRunner {
  constructor(private readonly options: ForwardSyncRunnerOptions) {}

  async run(job: ForwardSyncJob): Promise<void> {
    await Promise.all([
      this.consumePullRequests(job),
      this.consumeIssues(job),
    ]);
  }

  recordUnexpectedFailure(job: ForwardSyncJob, error: unknown): void {
    this.failStream(job, "pull_request", error);
    this.failStream(job, "issue", error);
  }

  private async consumePullRequests(job: ForwardSyncJob): Promise<void> {
    try {
      let latestRateLimit: GitHubRateLimit | undefined;
      const input: PullRequestSyncInput = {
        repository: toRepositoryRef(job.repository),
        mode: syncMode(job.pullRequestState),
        watermarkUpdatedAt: job.pullRequestState.watermarkUpdatedAt,
        syncStartedAt: job.run.startedAt,
        ...(job.lookbackDays === undefined ? {} : { lookbackDays: job.lookbackDays }),
      };
      for await (const page of this.options.provider.fetchPullRequestUpdates(input)) {
        const written = this.persistPullRequestPage(job, page);
        recordSyncRunPage(this.options.database, job.run.syncRunId, {
          entityKind: "pull_request",
          itemsSeen: page.items.length,
          itemsWritten: written,
          rateLimitRemaining: page.rateLimit.remaining,
        });
        latestRateLimit = page.rateLimit;
      }
      const state = completeSyncStream(this.options.database, {
        repositoryId: job.repository.id,
        entityKind: "pull_request",
        completedAt: this.options.timestamp(),
        rateLimitRemaining: latestRateLimit?.remaining,
        rateLimitResetAt: latestRateLimit?.resetAt,
      });
      await this.options.enrichPullRequestFiles(
        job.repository,
        latestRateLimit,
        [...job.targetNumbers.values()],
      );
      completeSyncRunStream(this.options.database, job.run.syncRunId, "pull_request", {
        finishedAt: this.options.timestamp(),
        rateLimitRemaining: latestRateLimit?.remaining,
        watermarkAfter: state.watermarkUpdatedAt,
      });
    } catch (error: unknown) {
      this.failStream(job, "pull_request", error);
    }
  }

  private async consumeIssues(job: ForwardSyncJob): Promise<void> {
    try {
      let latestRateLimit: GitHubRateLimit | undefined;
      const input: IssueSyncInput = {
        repository: toRepositoryRef(job.repository),
        mode: syncMode(job.issueState),
        watermarkUpdatedAt: job.issueState.watermarkUpdatedAt,
        syncStartedAt: job.run.startedAt,
        ...(job.lookbackDays === undefined ? {} : { lookbackDays: job.lookbackDays }),
      };
      for await (const page of this.options.provider.fetchIssueUpdates(input)) {
        const written = upsertIssuePage(this.options.database, job.repository.id, page.items);
        recordSyncRunPage(this.options.database, job.run.syncRunId, {
          entityKind: "issue",
          itemsSeen: page.items.length,
          itemsWritten: written,
          rateLimitRemaining: page.rateLimit.remaining,
        });
        latestRateLimit = page.rateLimit;
      }
      const state = completeSyncStream(this.options.database, {
        repositoryId: job.repository.id,
        entityKind: "issue",
        completedAt: this.options.timestamp(),
        rateLimitRemaining: latestRateLimit?.remaining,
        rateLimitResetAt: latestRateLimit?.resetAt,
      });
      completeSyncRunStream(this.options.database, job.run.syncRunId, "issue", {
        finishedAt: this.options.timestamp(),
        rateLimitRemaining: latestRateLimit?.remaining,
        watermarkAfter: state.watermarkUpdatedAt,
      });
    } catch (error: unknown) {
      this.failStream(job, "issue", error);
    }
  }

  private persistPullRequestPage(job: ForwardSyncJob, page: PullRequestPage): number {
    const before = this.readCurrentPullRequestHeads(job.repository.id, page.items);
    const written = upsertPullRequestPage(this.options.database, job.repository.id, page.items);
    for (const item of page.items) {
      const previous = before.get(item.number);
      const reason = previous === undefined
        ? "new"
        : previous.headSha !== item.headSha
          ? "head_changed"
          : previous.enriched ? null : "retry";
      if (reason !== null) {
        const target = { number: item.number, nodeId: item.nodeId, headSha: item.headSha };
        job.targetNumbers.set(item.number, target);
        recordSyncRunTarget(this.options.database, job.run.syncRunId, {
          repositoryId: job.repository.id,
          prNumber: item.number,
          headSha: item.headSha,
          reason,
        });
      }
    }
    return written;
  }

  private failStream(job: ForwardSyncJob, entityKind: "pull_request" | "issue", error: unknown): void {
    try {
      failSyncStream(this.options.database, {
        repositoryId: job.repository.id,
        entityKind,
        error,
        failedAt: this.options.timestamp(),
      });
    } catch (failure: unknown) {
      this.logError("Unable to record metadata sync failure", failure, {
        repositoryId: job.repository.id,
        entityKind,
      });
    }
    try {
      failSyncRunStream(
        this.options.database,
        job.run.syncRunId,
        entityKind,
        error,
        this.options.timestamp(),
      );
    } catch (failure: unknown) {
      this.logError("Unable to record metadata sync run failure", failure, {
        repositoryId: job.repository.id,
        entityKind,
      });
    }
  }

  private readCurrentPullRequestHeads(
    repositoryId: string,
    items: readonly PullRequestMetadata[],
  ): Map<number, { headSha: string; enriched: boolean }> {
    if (items.length === 0) return new Map();
    return new Map(
      listCurrentPullRequestEnrichmentStates(
        this.options.database,
        repositoryId,
        items.map((item) => item.number),
      ).map((state) => [state.number, {
        headSha: state.headSha,
        enriched: state.enriched,
      }]),
    );
  }

  private logError(message: string, error: unknown, context: Record<string, string>): void {
    this.options.logger.error(message, error, context);
  }
}

function syncMode(state: RepositorySyncState): "bootstrap" | "incremental" {
  return state.watermarkUpdatedAt === null ? "bootstrap" : "incremental";
}

function toRepositoryRef(repository: RepositoryRecord): { owner: string; name: string } {
  return { owner: repository.githubOwner, name: repository.githubName };
}
