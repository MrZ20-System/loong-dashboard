import type Database from "better-sqlite3";

import type { Migration } from "../migration-runner.js";

/** Durable state for asynchronous repository onboarding and restart recovery. */
export const repositoryOnboardingMigration: Migration = {
  id: "016_repository_onboarding",
  migrate(database: Database.Database): void {
    database.exec(`
      CREATE TABLE repository_onboarding_jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (
          status IN (
            'queued', 'validating', 'cloning', 'registering',
            'initializing', 'syncing', 'ready', 'failed', 'cancelled'
          )
        ),
        step TEXT NOT NULL CHECK (
          step IN (
            'queued', 'validating', 'cloning', 'registering',
            'initializing', 'syncing', 'ready', 'failed', 'cancelled'
          )
        ),
        detail TEXT NOT NULL,
        progress INTEGER NOT NULL CHECK (progress >= 0 AND progress <= 100),
        github TEXT NOT NULL,
        clone_url TEXT NOT NULL,
        repository_key TEXT NOT NULL,
        display_name TEXT NOT NULL,
        remote_name TEXT NOT NULL,
        default_branch TEXT NOT NULL,
        target_path TEXT NOT NULL,
        worktree_slots INTEGER NOT NULL CHECK (worktree_slots >= 1 AND worktree_slots <= 16),
        input_json TEXT NOT NULL,
        config_hash TEXT NOT NULL,
        repository_id TEXT,
        github_metadata_pending INTEGER NOT NULL DEFAULT 0 CHECK (github_metadata_pending IN (0, 1)),
        error_code TEXT,
        error_message TEXT,
        error_retryable INTEGER CHECK (error_retryable IS NULL OR error_retryable IN (0, 1)),
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE SET NULL,
        CHECK (
          (error_code IS NULL AND error_message IS NULL AND error_retryable IS NULL)
          OR (error_code IS NOT NULL AND error_message IS NOT NULL AND error_retryable IS NOT NULL)
        )
      );

      CREATE INDEX repository_onboarding_jobs_status_idx
        ON repository_onboarding_jobs(status, updated_at DESC);
      CREATE INDEX repository_onboarding_jobs_repository_idx
        ON repository_onboarding_jobs(repository_key, github);
    `);
  },
};
