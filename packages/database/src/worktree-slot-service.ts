import { randomUUID } from "node:crypto";

import type { DatabaseClient } from "./types.js";

/** One worktree_slots row as persisted metadata for pool allocation. */
export interface WorktreeSlotRow {
  id: string;
  repositoryId: string;
  slotName: string;
  path: string;
  prNumber: number | null;
  targetSha: string | null;
  lastUsedAt: string | null;
}

export interface RecordWorktreeSlotUseInput {
  repositoryId: string;
  slotName: string;
  path: string;
  prNumber: number;
  targetSha: string;
  lastUsedAt: string;
}

function mapWorktreeSlot(row: Record<string, unknown>): WorktreeSlotRow {
  return {
    id: row.id as string,
    repositoryId: row.repository_id as string,
    slotName: row.slot_name as string,
    path: row.path as string,
    prNumber: (row.pr_number as number | null) ?? null,
    targetSha: (row.target_sha as string | null) ?? null,
    lastUsedAt: (row.last_used_at as string | null) ?? null,
  };
}

function getWorktreeSlot(
  database: DatabaseClient,
  id: string,
): WorktreeSlotRow {
  const row = database
    .prepare("SELECT * FROM worktree_slots WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  if (row === undefined) {
    throw new Error(`Worktree slot row disappeared during update: ${id}`);
  }
  return mapWorktreeSlot(row);
}

/**
 * All worktree_slots metadata rows of one repository, by slot name. The
 * server passes these to the pool so PR affinity and LRU survive restarts.
 */
export function listWorktreeSlots(
  database: DatabaseClient,
  repositoryId: string,
): WorktreeSlotRow[] {
  const rows = database
    .prepare(
      `SELECT * FROM worktree_slots
       WHERE repository_id = ?
       ORDER BY slot_name`,
    )
    .all(repositoryId) as Array<Record<string, unknown>>;
  return rows.map(mapWorktreeSlot);
}

/**
 * Record one successful allocation/reuse/sync. The row is authoritative for
 * pr_number, target_sha, and last_used_at. Live ownership is supplied by the
 * running agent sessions and WorkspaceRunCoordinator.
 */
export function recordWorktreeSlotUse(
  database: DatabaseClient,
  input: RecordWorktreeSlotUseInput,
): WorktreeSlotRow {
  const existing = database
    .prepare(
      "SELECT id FROM worktree_slots WHERE repository_id = ? AND slot_name = ?",
    )
    .get(input.repositoryId, input.slotName) as { id: string } | undefined;

  if (existing === undefined) {
    const id = `wslot_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    database
      .prepare(
        `INSERT INTO worktree_slots (
          id, repository_id, slot_name, path, pr_number, target_sha,
          last_used_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.repositoryId,
        input.slotName,
        input.path,
        input.prNumber,
        input.targetSha,
        input.lastUsedAt,
      );
    return getWorktreeSlot(database, id);
  }

  database
    .prepare(
      `UPDATE worktree_slots
       SET path = ?, pr_number = ?, target_sha = ?, last_used_at = ?
       WHERE repository_id = ? AND slot_name = ?`,
    )
    .run(
      input.path,
      input.prNumber,
      input.targetSha,
      input.lastUsedAt,
      input.repositoryId,
      input.slotName,
    );
  return getWorktreeSlot(database, existing.id);
}

/**
 * Remove affinity metadata after the owning physical worktree was removed.
 * Live ownership is supplied by agent sessions/coordinator at the maintenance
 * boundary; this function only removes the exact affinity row.
 */
export function deleteWorktreeSlot(
  database: DatabaseClient,
  repositoryId: string,
  slotName: string,
  path: string,
): boolean {
  const result = database
    .prepare(
      `DELETE FROM worktree_slots
       WHERE repository_id = ? AND slot_name = ? AND path = ?`,
    )
    .run(repositoryId, slotName, path);
  return result.changes > 0;
}
