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
    if (state.syncedUpdatedAt === state.updatedAt) {
      return getIssueDetail(this.options.database, repositoryId, number);
    }

    if (this.options.github === undefined) {
      throw new Error(
        `Cannot refresh issue #${number}: GitHub metadata provider is not configured`,
      );
    }

    const key = `${repositoryId}:${number}`;
    const active = this.refreshes.get(key);
    if (active !== undefined) return active;

    const refresh = this.refresh(repositoryId, number).finally(() => {
      if (this.refreshes.get(key) === refresh) this.refreshes.delete(key);
    });
    this.refreshes.set(key, refresh);
    return refresh;
  }

  private async refresh(
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
