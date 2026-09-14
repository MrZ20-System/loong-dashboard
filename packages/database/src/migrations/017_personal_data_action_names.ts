import type Database from "better-sqlite3";

import type { Migration } from "../migration-runner.js";

/**
 * Rename the Knowledge backup actions without changing their task identity.
 * The stable system task ids intentionally remain `system_knowledge_*` so
 * scheduled_task_runs keep pointing at the same history after the upgrade.
 * The migration runner wraps this update in its transaction, so a failed
 * database upgrade cannot leave only one half of the pair renamed.
 */
export const personalDataActionNamesMigration: Migration = {
  id: "017_personal_data_action_names",
  migrate(database: Database.Database): void {
    database.exec(`
      UPDATE scheduled_tasks
      SET action = CASE action
        WHEN 'knowledge.checkpoint' THEN 'personal-data.checkpoint'
        WHEN 'knowledge-checkpoint' THEN 'personal-data.checkpoint'
        WHEN 'knowledge.push' THEN 'personal-data.push'
        WHEN 'knowledge-push' THEN 'personal-data.push'
        ELSE action
      END
      WHERE action IN (
        'knowledge.checkpoint',
        'knowledge-checkpoint',
        'knowledge.push',
        'knowledge-push',
        'personal-data.checkpoint',
        'personal-data.push'
      );

      UPDATE scheduled_tasks
      SET name = CASE action
        WHEN 'personal-data.checkpoint' THEN 'Personal Data checkpoint'
        WHEN 'personal-data.push' THEN 'Personal Data push'
        ELSE name
      END
      WHERE action IN ('personal-data.checkpoint', 'personal-data.push');
    `);
  },
};
