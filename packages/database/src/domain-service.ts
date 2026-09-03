import { randomBytes } from "node:crypto";

import { requireRepository } from "./repository-service.js";
import type { DatabaseClient, DomainRuleRecord } from "./types.js";

export class DomainNotFoundError extends Error {
  readonly code = "DOMAIN_NOT_FOUND" as const;

  constructor(domainId: string) {
    super(`Domain rule not found: ${domainId}`);
    this.name = "DomainNotFoundError";
  }
}

export class DomainNameConflictError extends Error {
  readonly code = "DOMAIN_NAME_CONFLICT" as const;

  constructor(name: string) {
    super(`A domain rule named "${name}" already exists for this repository`);
    this.name = "DomainNameConflictError";
  }
}

export interface DomainRuleCreateInput {
  name: string;
  color?: string | undefined;
  includePatterns: readonly string[];
  excludePatterns?: readonly string[] | undefined;
  enabled?: boolean | undefined;
}

export interface DomainRuleUpdateInput {
  name?: string | undefined;
  color?: string | undefined;
  includePatterns?: readonly string[] | undefined;
  excludePatterns?: readonly string[] | undefined;
  enabled?: boolean | undefined;
}

/** Rotating palette assigned when the caller does not pick a color. */
const COLOR_PALETTE = [
  "#2563eb",
  "#059669",
  "#d97706",
  "#dc2626",
  "#7c3aed",
  "#0891b2",
  "#be185d",
  "#65a30d",
] as const;

interface DomainRuleRow {
  id: string;
  repository_id: string;
  name: string;
  color: string;
  position: number;
  enabled: number;
  include_patterns_json: string;
  exclude_patterns_json: string;
  created_at: string;
  updated_at: string;
}

function mapRule(row: DomainRuleRow): DomainRuleRecord {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    name: row.name,
    color: row.color,
    position: row.position,
    enabled: row.enabled === 1,
    includePatterns: JSON.parse(row.include_patterns_json) as string[],
    excludePatterns: JSON.parse(row.exclude_patterns_json) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getRuleRow(
  database: DatabaseClient,
  repositoryId: string,
  domainId: string,
): DomainRuleRow | null {
  const row = database
    .prepare(
      `SELECT id, repository_id, name, color, position, enabled,
              include_patterns_json, exclude_patterns_json, created_at, updated_at
       FROM domain_rules
       WHERE repository_id = ? AND id = ?`,
    )
    .get(repositoryId, domainId) as DomainRuleRow | undefined;
  return row ?? null;
}

function assertNameAvailable(
  database: DatabaseClient,
  repositoryId: string,
  name: string,
  exceptDomainId?: string,
): void {
  const row = database
    .prepare(
      `SELECT id FROM domain_rules WHERE repository_id = ? AND name = ?`,
    )
    .get(repositoryId, name) as { id: string } | undefined;
  if (row !== undefined && row.id !== exceptDomainId) {
    throw new DomainNameConflictError(name);
  }
}

export function listDomainRules(
  database: DatabaseClient,
  repositoryId: string,
): DomainRuleRecord[] {
  requireRepository(database, repositoryId);
  const rows = database
    .prepare(
      `SELECT id, repository_id, name, color, position, enabled,
              include_patterns_json, exclude_patterns_json, created_at, updated_at
       FROM domain_rules
       WHERE repository_id = ?
       ORDER BY position ASC, id ASC`,
    )
    .all(repositoryId) as DomainRuleRow[];
  return rows.map(mapRule);
}

export function getDomainRule(
  database: DatabaseClient,
  repositoryId: string,
  domainId: string,
): DomainRuleRecord | null {
  requireRepository(database, repositoryId);
  const row = getRuleRow(database, repositoryId, domainId);
  return row === null ? null : mapRule(row);
}

export function createDomainRule(
  database: DatabaseClient,
  repositoryId: string,
  input: DomainRuleCreateInput,
  now: Date | string = new Date(),
): DomainRuleRecord {
  requireRepository(database, repositoryId);
  assertNameAvailable(database, repositoryId, input.name);
  const timestamp =
    typeof now === "string" ? now : now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const id = `dom_${randomBytes(8).toString("hex")}`;
  const nextPosition =
    (
      database
        .prepare(
          `SELECT COALESCE(MAX(position) + 1, 0) AS next_position
           FROM domain_rules WHERE repository_id = ?`,
        )
        .get(repositoryId) as { next_position: number }
    ).next_position;
  const color =
    input.color ?? COLOR_PALETTE[nextPosition % COLOR_PALETTE.length];

  database
    .prepare(
      `INSERT INTO domain_rules (
        id, repository_id, name, color, position, enabled,
        include_patterns_json, exclude_patterns_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      repositoryId,
      input.name,
      color,
      nextPosition,
      input.enabled === false ? 0 : 1,
      JSON.stringify(input.includePatterns),
      JSON.stringify(input.excludePatterns ?? []),
      timestamp,
      timestamp,
    );

  const created = getRuleRow(database, repositoryId, id);
  if (created === null) {
    throw new Error("Failed to read back the created domain rule");
  }
  return mapRule(created);
}

export function updateDomainRule(
  database: DatabaseClient,
  repositoryId: string,
  domainId: string,
  input: DomainRuleUpdateInput,
  now: Date | string = new Date(),
): DomainRuleRecord {
  requireRepository(database, repositoryId);
  const existing = getRuleRow(database, repositoryId, domainId);
  if (existing === null) throw new DomainNotFoundError(domainId);
  if (input.name !== undefined) {
    assertNameAvailable(database, repositoryId, input.name, domainId);
  }
  const timestamp =
    typeof now === "string" ? now : now.toISOString().replace(/\.\d{3}Z$/, "Z");

  database
    .prepare(
      `UPDATE domain_rules SET
        name = ?,
        color = ?,
        enabled = ?,
        include_patterns_json = ?,
        exclude_patterns_json = ?,
        updated_at = ?
      WHERE repository_id = ? AND id = ?`,
    )
    .run(
      input.name ?? existing.name,
      input.color ?? existing.color,
      input.enabled === undefined ? existing.enabled : input.enabled ? 1 : 0,
      JSON.stringify(
        input.includePatterns ??
          (JSON.parse(existing.include_patterns_json) as string[]),
      ),
      JSON.stringify(
        input.excludePatterns ??
          (JSON.parse(existing.exclude_patterns_json) as string[]),
      ),
      timestamp,
      repositoryId,
      domainId,
    );

  const updated = getRuleRow(database, repositoryId, domainId);
  if (updated === null) throw new DomainNotFoundError(domainId);
  return mapRule(updated);
}

export function deleteDomainRule(
  database: DatabaseClient,
  repositoryId: string,
  domainId: string,
): void {
  requireRepository(database, repositoryId);
  const result = database
    .prepare(`DELETE FROM domain_rules WHERE repository_id = ? AND id = ?`)
    .run(repositoryId, domainId);
  if (result.changes === 0) throw new DomainNotFoundError(domainId);
}
