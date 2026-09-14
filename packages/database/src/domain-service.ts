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

/** Projection payload produced by the file-backed Domain source. */
export interface DomainRuleProjectionInput {
  id: string;
  name: string;
  color: string;
  position: number;
  enabled: boolean;
  includePatterns: readonly string[];
  excludePatterns: readonly string[];
  createdAt?: string;
  updatedAt?: string;
}

export interface DomainRuleIdConflict {
  id: string;
  repositoryId: string;
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

/**
 * Find source ids already owned by another repository. Domain ids are a
 * database-wide primary key, so file-backed saves must check ownership before
 * replacing the durable source file.
 */
export function findDomainRuleIdConflicts(
  database: DatabaseClient,
  repositoryId: string,
  domainIds: readonly string[],
): DomainRuleIdConflict[] {
  requireRepository(database, repositoryId);
  if (domainIds.length === 0) return [];
  const requested = new Set(domainIds);
  const rows = database
    .prepare(
      `SELECT id, repository_id
       FROM domain_rules
       WHERE repository_id <> ?
       ORDER BY repository_id ASC, id ASC`,
    )
    .all(repositoryId) as Array<{ id: string; repository_id: string }>;
  return rows
    .filter((row) => requested.has(row.id))
    .map((row) => ({ id: row.id, repositoryId: row.repository_id }));
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

/**
 * Replace the SQLite classification projection from a durable Domain file.
 * The caller has already validated and atomically saved the source file.
 * Reclassification is intentionally triggered by the Server after this
 * transaction, keeping this package free of orchestration concerns.
 */
export function replaceDomainRulesFromFile(
  database: DatabaseClient,
  repositoryId: string,
  rules: readonly DomainRuleProjectionInput[],
  now: Date | string = new Date(),
): DomainRuleRecord[] {
  requireRepository(database, repositoryId);
  const timestamp =
    typeof now === "string" ? now : now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const rule of rules) {
    if (ids.has(rule.id)) throw new Error(`Duplicate domain rule id: ${rule.id}`);
    if (names.has(rule.name)) {
      throw new DomainNameConflictError(rule.name);
    }
    ids.add(rule.id);
    names.add(rule.name);
  }

  const existing = new Map(
    listDomainRules(database, repositoryId).map((rule) => [rule.id, rule] as const),
  );
  database.transaction(() => {
    database
      .prepare("DELETE FROM domain_rules WHERE repository_id = ?")
      .run(repositoryId);
    const insert = database.prepare(
      `INSERT INTO domain_rules (
        id, repository_id, name, color, position, enabled,
        include_patterns_json, exclude_patterns_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const rule of rules) {
      const previous = existing.get(rule.id);
      insert.run(
        rule.id,
        repositoryId,
        rule.name,
        rule.color,
        rule.position,
        rule.enabled ? 1 : 0,
        JSON.stringify(rule.includePatterns),
        JSON.stringify(rule.excludePatterns),
        rule.createdAt ?? previous?.createdAt ?? timestamp,
        rule.updatedAt ?? timestamp,
      );
    }
  })();
  return listDomainRules(database, repositoryId);
}
