import type { DomainTag } from "@loongboard/contracts";

import type {
  DatabaseClient,
  PullRequestFileRecord,
  PullRequestFileSet,
} from "./types.js";

export class PullRequestNotFoundError extends Error {
  readonly code = "PULL_REQUEST_NOT_FOUND" as const;

  constructor(repositoryId: string, prNumber: number) {
    super(`Pull request not found: ${repositoryId}#${prNumber}`);
    this.name = "PullRequestNotFoundError";
  }
}

export interface StoredPullRequestFiles {
  headSha: string;
  truncated: boolean;
  items: PullRequestFileRecord[];
}

/**
 * Replace the file set recorded for one PR head. Rows belonging to stale
 * heads of the same PR are removed so classification only ever sees the
 * current head. The truncation flag is stored on the PR row.
 */
export function replacePullRequestFiles(
  database: DatabaseClient,
  repositoryId: string,
  prNumber: number,
  headSha: string,
  files: readonly PullRequestFileRecord[],
  truncated: boolean,
): void {
  const insert = database.prepare(
    `INSERT INTO pull_request_files (
      repository_id, pr_number, head_sha, path, previous_path, change_type,
      additions, deletions
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(repository_id, pr_number, head_sha, path) DO UPDATE SET
      previous_path = excluded.previous_path,
      change_type = excluded.change_type,
      additions = excluded.additions,
      deletions = excluded.deletions`,
  );

  database.transaction(() => {
    database
      .prepare(
        `DELETE FROM pull_request_files
         WHERE repository_id = ? AND pr_number = ? AND head_sha != ?`,
      )
      .run(repositoryId, prNumber, headSha);
    for (const file of files) {
      insert.run(
        repositoryId,
        prNumber,
        headSha,
        file.path,
        file.previousPath,
        file.changeType,
        file.additions,
        file.deletions,
      );
    }
    database
      .prepare(
        `UPDATE pull_requests SET
           files_truncated = ?,
           payload_pruned_at = NULL
         WHERE repository_id = ? AND number = ?`,
      )
      .run(truncated ? 1 : 0, repositoryId, prNumber);
  })();
}

export interface PullRequestEnrichmentTarget {
  number: number;
  nodeId: string;
  headSha: string;
}

export interface PullRequestEnrichmentState {
  number: number;
  headSha: string;
  enriched: boolean;
}

/**
 * Read the stored current head and whether its file set is already present.
 * This is the typed boundary for coordinators deciding between new,
 * head-changed, retry, and already-enriched observations.
 */
export function listCurrentPullRequestEnrichmentStates(
  database: DatabaseClient,
  repositoryId: string,
  prNumbers: readonly number[],
): PullRequestEnrichmentState[] {
  if (prNumbers.length === 0) return [];
  const placeholders = prNumbers.map(() => "?").join(", ");
  return database
    .prepare(
      `SELECT pr.number AS number, pr.head_sha AS headSha,
         CASE
           WHEN pr.archived_at IS NOT NULL
             AND pr.payload_pruned_at IS NOT NULL
             AND pr.status IN ('closed', 'merged')
           THEN 1
           ELSE EXISTS (
           SELECT 1 FROM pull_request_files f
           WHERE f.repository_id = pr.repository_id
             AND f.pr_number = pr.number AND f.head_sha = pr.head_sha
           )
         END AS enriched
       FROM pull_requests pr
       WHERE pr.repository_id = ? AND pr.number IN (${placeholders})
       ORDER BY pr.number ASC`,
    )
    .all(repositoryId, ...prNumbers)
    .map((row) => {
      const value = row as { number: number; headSha: string; enriched: number };
      return {
        number: value.number,
        headSha: value.headSha,
        enriched: value.enriched === 1,
      };
    });
}

/**
 * A PR needs enrichment while no file rows exist for its current head SHA
 * (new PRs, head changes, and previously failed enrichments).
 */
export function listPullRequestsNeedingFileEnrichment(
  database: DatabaseClient,
  repositoryId: string,
  prNumbers?: readonly number[],
): PullRequestEnrichmentTarget[] {
  if (prNumbers !== undefined && prNumbers.length === 0) return [];
  const numberClause =
    prNumbers === undefined
      ? ""
      : ` AND pr.number IN (${prNumbers.map(() => "?").join(", ")})`;
  return database
    .prepare(
      `SELECT pr.number, pr.node_id AS nodeId, pr.head_sha AS headSha
       FROM pull_requests pr
         WHERE pr.repository_id = ?${numberClause}
         AND NOT (
           pr.archived_at IS NOT NULL
           AND pr.payload_pruned_at IS NOT NULL
           AND pr.status IN ('closed', 'merged')
         )
         AND NOT EXISTS (
           SELECT 1 FROM pull_request_files f
           WHERE f.repository_id = pr.repository_id
             AND f.pr_number = pr.number
             AND f.head_sha = pr.head_sha
         )
       ORDER BY pr.updated_at DESC, pr.number DESC`,
    )
    .all(repositoryId, ...(prNumbers ?? [])) as PullRequestEnrichmentTarget[];
}

/** Read the stored current-head files for the PR detail files endpoint. */
export function getPullRequestFiles(
  database: DatabaseClient,
  repositoryId: string,
  prNumber: number,
): StoredPullRequestFiles {
  const pr = database
    .prepare(
      `SELECT head_sha AS headSha, files_truncated AS truncated
       FROM pull_requests WHERE repository_id = ? AND number = ?`,
    )
    .get(repositoryId, prNumber) as
    | { headSha: string; truncated: number }
    | undefined;
  if (pr === undefined) {
    throw new PullRequestNotFoundError(repositoryId, prNumber);
  }
  const items = database
    .prepare(
      `SELECT path, previous_path AS previousPath, change_type AS changeType,
              additions, deletions
       FROM pull_request_files
       WHERE repository_id = ? AND pr_number = ? AND head_sha = ?
       ORDER BY path ASC`,
    )
    .all(repositoryId, prNumber, pr.headSha) as PullRequestFileRecord[];
  return { headSha: pr.headSha, truncated: pr.truncated === 1, items };
}

/**
 * Current-head file paths for every PR that has file rows, ordered for
 * deterministic batch reclassification.
 */
export function listPullRequestFileSets(
  database: DatabaseClient,
  repositoryId: string,
): PullRequestFileSet[] {
  const rows = database
    .prepare(
      `SELECT f.pr_number AS prNumber, f.head_sha AS headSha, f.path
       FROM pull_request_files f
       JOIN pull_requests pr
         ON pr.repository_id = f.repository_id AND pr.number = f.pr_number
       WHERE f.repository_id = ? AND f.head_sha = pr.head_sha
       ORDER BY f.pr_number ASC, f.path ASC`,
    )
    .all(repositoryId) as Array<{ prNumber: number; headSha: string; path: string }>;

  const sets: PullRequestFileSet[] = [];
  for (const row of rows) {
    const last = sets.at(-1);
    if (last !== undefined && last.prNumber === row.prNumber) {
      last.paths.push(row.path);
    } else {
      sets.push({ prNumber: row.prNumber, headSha: row.headSha, paths: [row.path] });
    }
  }
  return sets;
}

/**
 * Write the full domain set for one PR. When the stored classification key
 * already equals the computed key, the rows are left untouched.
 * Returns whether rows were (re)written.
 */
export function replacePullRequestDomains(
  database: DatabaseClient,
  repositoryId: string,
  prNumber: number,
  domainRuleIds: readonly string[],
  classificationKey: string,
): boolean {
  const existing = database
    .prepare(
      `SELECT DISTINCT classification_key AS key
       FROM pull_request_domains
       WHERE repository_id = ? AND pr_number = ?`,
    )
    .all(repositoryId, prNumber) as Array<{ key: string }>;
  if (
    existing.length === 1 &&
    existing[0]?.key === classificationKey &&
    domainRuleIds.length ===
      (database
        .prepare(
          `SELECT COUNT(*) AS count FROM pull_request_domains
           WHERE repository_id = ? AND pr_number = ?`,
        )
        .get(repositoryId, prNumber) as { count: number }).count
  ) {
    return false;
  }
  if (existing.length === 0 && domainRuleIds.length === 0) {
    return false;
  }

  const insert = database.prepare(
    `INSERT INTO pull_request_domains (
      repository_id, pr_number, domain_rule_id, classification_key
    ) VALUES (?, ?, ?, ?)`,
  );
  database.transaction(() => {
    database
      .prepare(
        `DELETE FROM pull_request_domains
         WHERE repository_id = ? AND pr_number = ?`,
      )
      .run(repositoryId, prNumber);
    for (const domainRuleId of domainRuleIds) {
      insert.run(repositoryId, prNumber, domainRuleId, classificationKey);
    }
  })();
  return true;
}

/** Batched domain chips for one list page, ordered by rule position. */
export function listDomainTagsForPullRequests(
  database: DatabaseClient,
  repositoryId: string,
  prNumbers: readonly number[],
): Map<number, DomainTag[]> {
  const tags = new Map<number, DomainTag[]>();
  if (prNumbers.length === 0) return tags;

  const placeholders = prNumbers.map(() => "?").join(", ");
  const rows = database
    .prepare(
      `SELECT d.pr_number AS prNumber, r.id, r.name, r.color
       FROM pull_request_domains d
       JOIN domain_rules r
         ON r.repository_id = d.repository_id AND r.id = d.domain_rule_id
       WHERE d.repository_id = ? AND d.pr_number IN (${placeholders})
       ORDER BY r.position ASC, r.id ASC`,
    )
    .all(repositoryId, ...prNumbers) as Array<{
    prNumber: number;
    id: string;
    name: string;
    color: string;
  }>;

  for (const row of rows) {
    const list = tags.get(row.prNumber) ?? [];
    list.push({ id: row.id, name: row.name, color: row.color });
    tags.set(row.prNumber, list);
  }
  return tags;
}
