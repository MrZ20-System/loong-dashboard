import {
  getIssueDetail,
  getIssueDetailCacheState,
  replaceIssueDetailCache,
  requireRepository,
  type DatabaseClient,
  type IssueDetail,
} from "@loongboard/database";
import type { GitHubMetadataProvider } from "@loongboard/github";

export interface IssueDetailServiceOptions {
  database: DatabaseClient;
  github?: GitHubMetadataProvider;
}

/** Lazy Issue detail cache with one refresh shared by concurrent readers. */
export class IssueDetailService {
  private readonly refreshes = new Map<string, Promise<IssueDetail | null>>();

  constructor(private readonly options: IssueDetailServiceOptions) {}

  async get(repositoryId: string, number: number): Promise<IssueDetail | null> {
    const state = getIssueDetailCacheState(this.options.database, repositoryId, number);
    if (state === null) return null;
    // Payload-pruned Issues are intentionally offline reads. Their local row
    // remains useful for core metadata, but a normal GET must not turn a
    // retention marker into an implicit GitHub request.
    if (state.payloadPrunedAt !== null) {
      return this.getCore(repositoryId, number);
    }
    // An archived but unpruned Issue still has a complete local detail cache;
    // serve it without attempting a lazy refresh.
    if (state.archivedAt !== null) {
      return getIssueDetail(this.options.database, repositoryId, number);
    }
    if (state.syncedUpdatedAt === state.updatedAt) {
      return getIssueDetail(this.options.database, repositoryId, number);
    }

    return this.refresh(repositoryId, number);
  }

  /** Explicit user-requested refresh, including archived/pruned Issues. */
  async refresh(repositoryId: string, number: number): Promise<IssueDetail | null> {
    const state = getIssueDetailCacheState(this.options.database, repositoryId, number);
    if (state === null) return null;
    if (this.options.github === undefined) {
      throw new Error(
        `Cannot refresh issue #${number}: GitHub metadata provider is not configured`,
      );
    }

    const key = `${repositoryId}:${number}`;
    const active = this.refreshes.get(key);
    if (active !== undefined) return active;

    const refresh = this.refreshFromGithub(repositoryId, number).finally(() => {
      if (this.refreshes.get(key) === refresh) this.refreshes.delete(key);
    });
    this.refreshes.set(key, refresh);
    return refresh;
  }

  private getCore(repositoryId: string, number: number): IssueDetail | null {
    const issue = getIssueDetail(this.options.database, repositoryId, number);
    if (issue === null) return null;
    return {
      ...issue,
      detailBody: null,
      comments: [],
    };
  }

  private async refreshFromGithub(
    repositoryId: string,
    number: number,
  ): Promise<IssueDetail | null> {
    const repository = requireRepository(this.options.database, repositoryId);
    const fetched = await this.options.github!.fetchIssueDetail({
      repository: {
        owner: repository.githubOwner,
        name: repository.githubName,
      },
      number,
    });
    replaceIssueDetailCache(this.options.database, repositoryId, fetched);
    return getIssueDetail(this.options.database, repositoryId, number);
  }
}
