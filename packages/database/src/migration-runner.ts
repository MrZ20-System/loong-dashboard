import Database from "better-sqlite3";

import { initialSchemaMigration } from "./migrations/001-initial-schema.js";
import { metadataListIndexesMigration } from "./migrations/002-metadata-list-indexes.js";
import { issueStateConstraintMigration } from "./migrations/003-issue-state-constraint.js";
import { domainClassificationMigration } from "./migrations/004-domain-classification.js";
import { issueDetailCacheMigration } from "./migrations/005-issue-detail-cache.js";
import { agentRuntimeSchedulerMigration } from "./migrations/006-agent-runtime-scheduler.js";
import { repositorySyncHistoryMigration } from "./migrations/007-repository-sync-history.js";
import { pullRequestLifecycleMigration } from "./migrations/008-pull-request-lifecycle.js";
import { listQueryModesMigration } from "./migrations/009-list-query-modes.js";
import { removeDailyProjectionsMigration } from "./migrations/010-remove-daily-projections.js";
import {
  recoverInterruptedSyncRuns,
  recoverInterruptedSyncStates,
} from "./sync-service.js";

export interface Migration {
  readonly id: string;
  migrate(database: Database.Database): void;
}

const migrations: readonly Migration[] = [
  initialSchemaMigration,
  metadataListIndexesMigration,
  issueStateConstraintMigration,
  domainClassificationMigration,
  issueDetailCacheMigration,
  agentRuntimeSchedulerMigration,
  repositorySyncHistoryMigration,
  pullRequestLifecycleMigration,
  listQueryModesMigration,
  removeDailyProjectionsMigration,
];

function orderedMigrations(items: readonly Migration[]): readonly Migration[] {
  const ordered = [...items].sort((left, right) => left.id.localeCompare(right.id));
  const ids = new Set<string>();

  for (const migration of ordered) {
    if (ids.has(migration.id)) {
      throw new Error(`Duplicate database migration id: ${migration.id}`);
    }
    ids.add(migration.id);
  }

  return ordered;
}

export function runMigrations(database: Database.Database): void {
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const hasMigration = database.prepare(
    "SELECT 1 FROM schema_migrations WHERE id = ?",
  );
  const recordMigration = database.prepare(
    "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)",
  );

  for (const migration of orderedMigrations(migrations)) {
    if (hasMigration.get(migration.id) !== undefined) {
      continue;
    }

    database.transaction(() => {
      migration.migrate(database);
      recordMigration.run(migration.id, new Date().toISOString());
    })();
  }
}

export function openDatabase(databasePath: string): Database.Database {
  if (databasePath.length === 0) {
    throw new Error("Database path must not be empty");
  }

  const database = new Database(databasePath);

  try {
    runMigrations(database);
    recoverInterruptedSyncStates(database);
    recoverInterruptedSyncRuns(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
