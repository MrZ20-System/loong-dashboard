import type Database from "better-sqlite3";

import {
  type ConfiguredRepository,
  type DatabaseClient,
  type RepositoryRecord,
} from "./types.js";

const ENTITY_KINDS = ["pull_request", "issue"] as const;

export class RepositoryNotFoundError extends Error {
  readonly code = "REPOSITORY_NOT_FOUND" as const;

  constructor(repositoryId: string) {
    super(`Repository is missing or disabled: ${repositoryId}`);
    this.name = "RepositoryNotFoundError";
  }
}

function currentTimestamp(value?: Date | string): string {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error("Invalid timestamp");
    return value.toISOString();
  }
  if (typeof value === "string") {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) throw new Error(`Invalid timestamp: ${value}`);
    return new Date(timestamp).toISOString();
  }
  return new Date().toISOString();
}

function splitGithubRepository(github: string): [string, string] {
  const pieces = github.split("/");
  if (pieces.length !== 2 || pieces.some((piece) => piece.trim().length === 0)) {
    throw new Error(`Invalid GitHub repository identifier: ${github}`);
  }
  return [pieces[0], pieces[1]];
}

function mapRepository(row: Record<string, unknown>): RepositoryRecord {
  return {
    id: row.id as string,
    key: row.key as string,
    displayName: row.display_name as string,
    githubOwner: row.github_owner as string,
    githubName: row.github_name as string,
    localPath: row.local_path as string,
    remoteName: row.remote_name as string,
    defaultBranch: row.default_branch as string,
    worktreeSlots: row.worktree_slots as number,
    enabled: (row.enabled as number) === 1,
    pullRequestCount: Number(row.pull_request_count ?? 0),
    mergedPullRequestCount: Number(row.merged_pull_request_count ?? 0),
    issueCount: Number(row.issue_count ?? 0),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function ensureSyncRows(database: DatabaseClient, repositoryId: string): void {
  const insert = database.prepare(
    `INSERT INTO repository_sync_state
      (repository_id, entity_kind, status)
     VALUES (?, ?, 'idle')
     ON CONFLICT(repository_id, entity_kind) DO NOTHING`,
  );
  for (const entityKind of ENTITY_KINDS) insert.run(repositoryId, entityKind);
}

function repositoryValuesEqual(
  existing: RepositoryRecord,
  repository: ConfiguredRepository,
  githubOwner: string,
  githubName: string,
): boolean {
  return (
    existing.id === repository.key &&
    existing.key === repository.key &&
    existing.displayName === repository.name &&
    existing.githubOwner === githubOwner &&
    existing.githubName === githubName &&
    existing.localPath === repository.path &&
    existing.remoteName === repository.remote &&
    existing.defaultBranch === repository.defaultBranch &&
    existing.worktreeSlots === repository.worktreeSlots &&
    existing.enabled
  );
}

/**
 * Reconcile system.yaml repository entries into SQLite.
 *
 * Repository keys are durable IDs. Removed entries are disabled in place so
 * their metadata, sync state, and future session references remain recoverable.
 */
export function reconcileRepositories(
  database: DatabaseClient,
  configuredRepositories: readonly ConfiguredRepository[],
  now?: Date | string,
): RepositoryRecord[] {
  const timestamp = currentTimestamp(now);
  const seenKeys = new Set<string>();
  const seenGithub = new Set<string>();

  for (const repository of configuredRepositories) {
    const normalizedKey = repository.key.toLocaleLowerCase("en-US");
    if (seenKeys.has(normalizedKey)) {
      throw new Error(`Duplicate configured repository key: ${repository.key}`);
    }
    seenKeys.add(normalizedKey);
    const [owner, name] = splitGithubRepository(repository.github);
    const githubKey = `${owner}/${name}`.toLocaleLowerCase("en-US");
    if (seenGithub.has(githubKey)) {
      throw new Error(`Duplicate configured GitHub repository: ${githubKey}`);
    }
    seenGithub.add(githubKey);
  }

  database.transaction(() => {
    const select = database.prepare(
      "SELECT * FROM repositories WHERE id = ?",
    );
    const insert = database.prepare(
      `INSERT INTO repositories
        (id, key, display_name, github_owner, github_name, local_path,
         remote_name, default_branch, worktree_slots, enabled, created_at,
         updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    );
    const update = database.prepare(
      `UPDATE repositories SET
        key = ?, display_name = ?, github_owner = ?, github_name = ?,
        local_path = ?, remote_name = ?, default_branch = ?, worktree_slots = ?,
        enabled = 1, updated_at = ?
       WHERE id = ?`,
    );
    const disable = database.prepare(
      "UPDATE repositories SET enabled = 0, updated_at = ? WHERE id = ? AND enabled = 1",
    );

    for (const repository of configuredRepositories) {
      const [githubOwner, githubName] = splitGithubRepository(repository.github);
      const existingRow = select.get(repository.key) as Record<string, unknown> | undefined;
      if (existingRow === undefined) {
        insert.run(
          repository.key,
          repository.key,
          repository.name,
          githubOwner,
          githubName,
          repository.path,
          repository.remote,
          repository.defaultBranch,
          repository.worktreeSlots,
          timestamp,
          timestamp,
        );
      } else {
        const existing = mapRepository(existingRow);
        if (!repositoryValuesEqual(existing, repository, githubOwner, githubName)) {
          update.run(
            repository.key,
            repository.name,
            githubOwner,
            githubName,
            repository.path,
            repository.remote,
            repository.defaultBranch,
            repository.worktreeSlots,
            timestamp,
            repository.key,
          );
        }
      }
      ensureSyncRows(database, repository.key);
    }

    const existingRows = database
      .prepare("SELECT id FROM repositories WHERE enabled = 1")
      .all() as Array<{ id: string }>;
    for (const row of existingRows) {
      if (!seenKeys.has(row.id.toLocaleLowerCase("en-US"))) disable.run(timestamp, row.id);
    }
  })();

  return listAllRepositories(database);
}

function listAllRepositories(database: DatabaseClient): RepositoryRecord[] {
  const rows = database
    .prepare(
      `SELECT repositories.*,
              (SELECT COUNT(*) FROM pull_requests
               WHERE pull_requests.repository_id = repositories.id) AS pull_request_count,
              (SELECT COUNT(*) FROM pull_requests
               WHERE pull_requests.repository_id = repositories.id
                 AND pull_requests.merged_at IS NOT NULL) AS merged_pull_request_count,
              (SELECT COUNT(*) FROM issues
               WHERE issues.repository_id = repositories.id) AS issue_count
       FROM repositories
       ORDER BY key ASC`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map(mapRepository);
}

export function listRepositories(database: DatabaseClient): RepositoryRecord[] {
  const rows = database
    .prepare(
      `SELECT repositories.*,
              (SELECT COUNT(*) FROM pull_requests
               WHERE pull_requests.repository_id = repositories.id) AS pull_request_count,
              (SELECT COUNT(*) FROM pull_requests
               WHERE pull_requests.repository_id = repositories.id
                 AND pull_requests.merged_at IS NOT NULL) AS merged_pull_request_count,
              (SELECT COUNT(*) FROM issues
               WHERE issues.repository_id = repositories.id) AS issue_count
       FROM repositories
       WHERE enabled = 1
       ORDER BY key ASC`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map(mapRepository);
}

export function getRepository(
  database: DatabaseClient,
  repositoryId: string,
): RepositoryRecord | null {
  const row = database
    .prepare(
      `SELECT repositories.*,
              (SELECT COUNT(*) FROM pull_requests
               WHERE pull_requests.repository_id = repositories.id) AS pull_request_count,
              (SELECT COUNT(*) FROM pull_requests
               WHERE pull_requests.repository_id = repositories.id
                 AND pull_requests.merged_at IS NOT NULL) AS merged_pull_request_count,
              (SELECT COUNT(*) FROM issues
               WHERE issues.repository_id = repositories.id) AS issue_count
       FROM repositories WHERE id = ?
       AND enabled = 1`,
    )
    .get(repositoryId) as Record<string, unknown> | undefined;
  return row === undefined ? null : mapRepository(row);
}

export function requireRepository(
  database: DatabaseClient,
  repositoryId: string,
): RepositoryRecord {
  const repository = getRepository(database, repositoryId);
  if (repository === null) throw new RepositoryNotFoundError(repositoryId);
  return repository;
}
