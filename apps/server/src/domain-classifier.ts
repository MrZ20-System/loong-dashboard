import { createHash } from "node:crypto";

import picomatch from "picomatch";

import type { DomainRuleRecord } from "@loongboard/database";

/**
 * Deterministic domain classification (plan 10).
 *
 * A rule attaches to a pull request when at least one current-head file
 * path matches ANY include pattern AND matches NO exclude pattern
 * (picomatch, `dot: true`). One PR can carry multiple domains; there is no
 * primary domain, no confidence score, and no AI involvement.
 */

/** Normalize a changed-file path for matching: `/` separators, no `./`. */
export function normalizeMatchPath(path: string): string {
  let normalized = path.replace(/\\/g, "/");
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  return normalized;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Hash of the classification-relevant rule state. Only enabled rules and
 * only their id/include/exclude fields participate, so renames, recolors,
 * and reordering never invalidate stored classifications (plan 10.2).
 */
export function computeRuleSetHash(
  rules: readonly DomainRuleRecord[],
): string {
  const relevant = rules
    .filter((rule) => rule.enabled)
    .map((rule) => ({
      id: rule.id,
      includePatterns: rule.includePatterns,
      excludePatterns: rule.excludePatterns,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return sha256(JSON.stringify(relevant));
}

/** Hash of the sorted, normalized current-head file paths of one PR. */
export function computeFileSetHash(paths: readonly string[]): string {
  const normalized = paths.map(normalizeMatchPath).sort();
  return sha256(normalized.join("\n"));
}

/** Per-PR classification key stored on every domain row (plan 10.2). */
export function computeClassificationKey(
  ruleSetHash: string,
  fileSetHash: string,
): string {
  return sha256(`${ruleSetHash}\n${fileSetHash}`);
}

interface CompiledRule {
  readonly id: string;
  readonly position: number;
  readonly includes: (path: string) => boolean;
  readonly excludes: (path: string) => boolean;
}

function compileRule(rule: DomainRuleRecord): CompiledRule {
  const options = { dot: true } as const;
  const includes = picomatch(rule.includePatterns, options);
  const excludes =
    rule.excludePatterns.length > 0
      ? picomatch(rule.excludePatterns, options)
      : () => false;
  return {
    id: rule.id,
    position: rule.position,
    includes,
    excludes,
  };
}

/**
 * Return the ids of every enabled rule matching the file set, ordered by
 * rule position then id for deterministic output. Disabled rules never
 * match. Paths are normalized once before matching.
 */
export function classifyFileSet(
  paths: readonly string[],
  rules: readonly DomainRuleRecord[],
): string[] {
  const normalized = paths.map(normalizeMatchPath);
  const compiled = rules
    .filter((rule) => rule.enabled)
    .map(compileRule)
    .sort(
      (left, right) =>
        left.position - right.position || left.id.localeCompare(right.id),
    );

  const matched: string[] = [];
  for (const rule of compiled) {
    const hit = normalized.some(
      (path) => rule.includes(path) && !rule.excludes(path),
    );
    if (hit) {
      matched.push(rule.id);
    }
  }
  return matched;
}
