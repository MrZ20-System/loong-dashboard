import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupDatabaseDirectories,
  repository,
  withDatabase,
} from "./support.js";
import {
  createDomainRule,
  deleteDomainRule,
  DomainNameConflictError,
  DomainNotFoundError,
  getDomainRule,
  listDomainRules,
  reconcileRepositories,
  replaceDomainRulesFromFile,
  updateDomainRule,
} from "../src/index.js";

afterEach(cleanupDatabaseDirectories);

describe("domain rule persistence", () => {
  it("creates, updates, orders, and deletes rules through the typed service", () => {
    withDatabase((database) => {
      reconcileRepositories(database, [repository("repo")]);
      const first = createDomainRule(
        database,
        "repo",
        {
          name: "Frontend",
          color: "#111111",
          includePatterns: ["apps/web/**"],
          excludePatterns: ["**/*.snap"],
        },
        "2026-09-01T00:00:00.000Z",
      );
      const second = createDomainRule(
        database,
        "repo",
        {
          name: "Backend",
          includePatterns: ["apps/server/**"],
          enabled: false,
        },
        "2026-09-02T00:00:00.000Z",
      );

      expect(listDomainRules(database, "repo")).toEqual([
        expect.objectContaining({
          id: first.id,
          name: "Frontend",
          position: 0,
          color: "#111111",
          enabled: true,
          includePatterns: ["apps/web/**"],
          excludePatterns: ["**/*.snap"],
        }),
        expect.objectContaining({
          id: second.id,
          name: "Backend",
          position: 1,
          enabled: false,
        }),
      ]);

      const updated = updateDomainRule(
        database,
        "repo",
        first.id,
        {
          name: "Web",
          enabled: false,
          includePatterns: ["apps/web/**", "packages/contracts/**"],
        },
        "2026-09-03T00:00:00.000Z",
      );
      expect(updated).toMatchObject({
        id: first.id,
        name: "Web",
        color: "#111111",
        position: 0,
        enabled: false,
        includePatterns: ["apps/web/**", "packages/contracts/**"],
        excludePatterns: ["**/*.snap"],
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-03T00:00:00.000Z",
      });
      expect(getDomainRule(database, "repo", first.id)).toEqual(updated);
      expect(() => createDomainRule(database, "repo", {
        name: "Web",
        includePatterns: [],
      })).toThrowError(DomainNameConflictError);

      deleteDomainRule(database, "repo", second.id);
      expect(getDomainRule(database, "repo", second.id)).toBeNull();
      expect(() => deleteDomainRule(database, "repo", second.id)).toThrowError(
        DomainNotFoundError,
      );
    });
  });

  it("replaces the file-backed projection while preserving matching history", () => {
    withDatabase((database) => {
      reconcileRepositories(database, [repository("repo")]);
      const existing = createDomainRule(
        database,
        "repo",
        {
          name: "Old name",
          includePatterns: ["old/**"],
        },
        "2026-09-01T00:00:00.000Z",
      );

      const projected = replaceDomainRulesFromFile(
        database,
        "repo",
        [
          {
            id: existing.id,
            name: "Canonical name",
            color: "#222222",
            position: 4,
            enabled: true,
            includePatterns: ["canonical/**"],
            excludePatterns: [],
            updatedAt: "2026-09-04T00:00:00.000Z",
          },
          {
            id: "dom-from-file",
            name: "New domain",
            color: "#333333",
            position: 1,
            enabled: false,
            includePatterns: ["new/**"],
            excludePatterns: ["new/tmp/**"],
            createdAt: "2026-09-04T00:00:00.000Z",
            updatedAt: "2026-09-04T00:00:00.000Z",
          },
        ],
        "2026-09-04T00:00:00.000Z",
      );

      expect(projected).toEqual([
        expect.objectContaining({
          id: "dom-from-file",
          name: "New domain",
          position: 1,
          enabled: false,
        }),
        expect.objectContaining({
          id: existing.id,
          name: "Canonical name",
          position: 4,
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-04T00:00:00.000Z",
        }),
      ]);
      expect(() => replaceDomainRulesFromFile(database, "repo", [
        {
          id: "duplicate-a",
          name: "Duplicate",
          color: "#111111",
          position: 0,
          enabled: true,
          includePatterns: [],
          excludePatterns: [],
        },
        {
          id: "duplicate-b",
          name: "Duplicate",
          color: "#222222",
          position: 1,
          enabled: true,
          includePatterns: [],
          excludePatterns: [],
        },
      ])).toThrowError(DomainNameConflictError);
    });
  });
});
