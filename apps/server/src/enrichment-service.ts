import {
  listDomainRules,
  listPullRequestsNeedingFileEnrichment,
  replacePullRequestDomains,
  replacePullRequestFiles,
  type DatabaseClient,
  type RepositoryRecord,
} from "@loongboard/database";
import type {
  GitHubMetadataProvider,
  GitHubRateLimit,
} from "@loongboard/github";

import {
  classifyFileSet,
  computeClassificationKey,
  computeFileSetHash,
  computeRuleSetHash,
} from "./domain-classifier.js";

/**
 * Metadata wins over enrichment: when the metadata stream reports fewer
 * remaining rate-limit points than this floor, file enrichment is skipped
 * for the round (stage-2 frozen decision D5).
 */
const RATE_LIMIT_ENRICHMENT_FLOOR = 200;

/** The narrow collaborator the sync coordinator depends on. */
export interface PullRequestFileEnricher {
  enrich(
    repository: RepositoryRecord,
    rateLimit: GitHubRateLimit | undefined,
  ): Promise<void>;
}

export interface EnrichmentLogger {
  error(...arguments_: readonly unknown[]): void;
  info?(...arguments_: readonly unknown[]): void;
}

export interface PullRequestEnrichmentServiceOptions {
  database: DatabaseClient;
  provider: GitHubMetadataProvider;
  logger?: EnrichmentLogger;
  rateLimitFloor?: number;
}

/**
 * Changed-file path enrichment after a successful PR metadata stream
 * (plan 9.6/9.9). Failures are logged and swallowed by the caller; PRs that
 * were not enriched simply surface again on the next sync round.
 */
export class PullRequestEnrichmentService implements PullRequestFileEnricher {
  private readonly database: DatabaseClient;
  private readonly provider: GitHubMetadataProvider;
  private readonly logger: EnrichmentLogger;
  private readonly rateLimitFloor: number;

  constructor(options: PullRequestEnrichmentServiceOptions) {
    if (
      options.rateLimitFloor !== undefined &&
      (!Number.isInteger(options.rateLimitFloor) || options.rateLimitFloor < 0)
    ) {
      throw new Error("rateLimitFloor must be a non-negative integer");
    }
    this.database = options.database;
    this.provider = options.provider;
    this.logger = options.logger ?? console;
    this.rateLimitFloor = options.rateLimitFloor ?? RATE_LIMIT_ENRICHMENT_FLOOR;
  }

  async enrich(
    repository: RepositoryRecord,
    rateLimit: GitHubRateLimit | undefined,
  ): Promise<void> {
    if (rateLimit !== undefined && rateLimit.remaining < this.rateLimitFloor) {
      this.logger.info?.(
        `Skipping file enrichment for ${repository.id}: rate limit remaining ${rateLimit.remaining} is below ${this.rateLimitFloor}`,
      );
      return;
    }

    const targets = listPullRequestsNeedingFileEnrichment(
      this.database,
      repository.id,
    );
    if (targets.length === 0) {
      return;
    }

    const headShaByNumber = new Map(
      targets.map((target) => [target.number, target.headSha]),
    );
    const results = await this.provider.fetchPullRequestFiles({
      repository: {
        owner: repository.githubOwner,
        name: repository.githubName,
      },
      pullRequests: targets.map((target) => ({
        nodeId: target.nodeId,
        number: target.number,
      })),
    });

    const rules = listDomainRules(this.database, repository.id);
    const ruleSetHash = computeRuleSetHash(rules);

    for (const result of results) {
      const headSha = headShaByNumber.get(result.number);
      if (headSha === undefined) {
        continue;
      }
      const files = result.files.map((file) => ({
        path: file.path,
        previousPath: file.previousPath,
        changeType: file.changeType,
        additions: file.additions,
        deletions: file.deletions,
      }));
      replacePullRequestFiles(
        this.database,
        repository.id,
        result.number,
        headSha,
        files,
        result.truncated,
      );

      // Classify the fresh file set locally; the classification key skips
      // the write when nothing relevant changed.
      const paths = files.map((file) => file.path);
      const key = computeClassificationKey(
        ruleSetHash,
        computeFileSetHash(paths),
      );
      const domainRuleIds = classifyFileSet(paths, rules);
      replacePullRequestDomains(
        this.database,
        repository.id,
        result.number,
        domainRuleIds,
        key,
      );
    }
  }
}
