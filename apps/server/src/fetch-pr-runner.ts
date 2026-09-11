import {
  completeSyncRunStream,
  failSyncRunStream,
  recordSyncRunPage,
  recordSyncRunTarget,
  upsertPullRequestPage,
  type DatabaseClient,
  type PullRequestEnrichmentTarget,
  type RepositoryRecord,
  type SyncRun,
} from "@loongboard/database";
import type {
  GitHubMetadataProvider,
  GitHubRateLimit,
  PullRequestFetchInput,
} from "@loongboard/github";

export interface FetchPullRequestJob {
  readonly kind: "fetch_pr";
  readonly run: SyncRun;
  readonly repository: RepositoryRecord;
  readonly number: number;
  readonly targetNumbers: Map<number, PullRequestEnrichmentTarget>;
}

interface FetchPullRequestRunnerLogger {
  error(...arguments_: readonly unknown[]): void;
}

export interface FetchPullRequestRunnerOptions {
  readonly database: DatabaseClient;
  readonly provider: GitHubMetadataProvider;
  readonly logger: FetchPullRequestRunnerLogger;
  readonly timestamp: () => string;
  readonly enrichPullRequestFiles: (
    repository: RepositoryRecord,
    rateLimit: GitHubRateLimit | undefined,
    targets: readonly PullRequestEnrichmentTarget[],
  ) => Promise<void>;
}

/** Fetches one PR, records its target, and completes its independent stream. */
export class FetchPullRequestRunner {
  constructor(private readonly options: FetchPullRequestRunnerOptions) {}

  async run(job: FetchPullRequestJob): Promise<void> {
    try {
      if (this.options.provider.fetchPullRequest === undefined) {
        throw new Error("GitHub provider does not support single pull request fetch");
      }
      const item = await this.options.provider.fetchPullRequest({
        repository: toRepositoryRef(job.repository),
        number: job.number,
      } satisfies PullRequestFetchInput);
      const written = upsertPullRequestPage(this.options.database, job.repository.id, [item]);
      const target = { number: item.number, nodeId: item.nodeId, headSha: item.headSha };
      job.targetNumbers.set(item.number, target);
      recordSyncRunTarget(this.options.database, job.run.syncRunId, {
        repositoryId: job.repository.id,
        prNumber: item.number,
        headSha: item.headSha,
        reason: "fetch_pr",
      });
      recordSyncRunPage(this.options.database, job.run.syncRunId, {
        entityKind: "pull_request",
        itemsSeen: 1,
        itemsWritten: written,
      });
      await this.options.enrichPullRequestFiles(job.repository, undefined, [target]);
      completeSyncRunStream(this.options.database, job.run.syncRunId, "pull_request", {
        finishedAt: this.options.timestamp(),
        watermarkAfter: null,
      });
    } catch (error: unknown) {
      this.failStream(job, error);
    }
  }

  recordUnexpectedFailure(job: FetchPullRequestJob, error: unknown): void {
    this.failStream(job, error);
  }

  private failStream(job: FetchPullRequestJob, error: unknown): void {
    try {
      failSyncRunStream(
        this.options.database,
        job.run.syncRunId,
        "pull_request",
        error,
        this.options.timestamp(),
      );
    } catch (failure: unknown) {
      this.options.logger.error("Unable to record fetch PR failure", failure, {
        repositoryId: job.repository.id,
        number: String(job.number),
      });
    }
  }
}

function toRepositoryRef(repository: RepositoryRecord): { owner: string; name: string } {
  return { owner: repository.githubOwner, name: repository.githubName };
}
