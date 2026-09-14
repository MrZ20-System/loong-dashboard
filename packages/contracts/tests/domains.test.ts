import { describe, expect, it } from "vitest";

import {
  domainRuleCreateSchema,
  domainRuleSchema,
  domainSourceDocumentSchema,
} from "../src/index.js";

describe("Domain contracts", () => {
  it("accepts large pattern sets and long non-empty glob expressions", () => {
    const includePatterns = Array.from({ length: 200 }, (_, index) => `src/path-${index}/**`);
    const excludePatterns = Array.from({ length: 200 }, (_, index) => `src/path-${index}/generated/**`);
    const longPattern = `${"nested/".repeat(50)}**`;
    includePatterns.push(longPattern);

    expect(domainRuleCreateSchema.parse({
      name: "A domain name that is intentionally longer than forty characters",
      includePatterns,
      excludePatterns,
    })).toMatchObject({ includePatterns, excludePatterns });

    expect(domainSourceDocumentSchema.parse({
      version: 1,
      repositoryId: "repo",
      metadata: { owner: "user" },
      domains: [{
        id: `dom_${"stable-identifier-".repeat(5)}`,
        name: "A domain name that is intentionally longer than forty characters",
        includePatterns,
        excludePatterns,
        custom: { retained: true },
      }],
    })).toMatchObject({
      metadata: { owner: "user" },
      domains: [{ custom: { retained: true }, includePatterns, excludePatterns }],
    });
  });

  it("uses the same semantic constraints for source entries and projected rules", () => {
    const base = {
      name: "Docs",
      includePatterns: ["docs/**"],
    };
    expect(domainSourceDocumentSchema.safeParse({ domains: [{ ...base, includePatterns: [] }] }).success).toBe(false);
    expect(domainSourceDocumentSchema.safeParse({ domains: [{ ...base, includePatterns: [""] }] }).success).toBe(false);
    expect(domainSourceDocumentSchema.safeParse({ domains: [{ ...base, color: "blue" }] }).success).toBe(false);
    expect(domainSourceDocumentSchema.safeParse({ domains: [{ ...base, enabled: "yes" }] }).success).toBe(false);
    expect(domainSourceDocumentSchema.safeParse({ domains: [{ ...base, position: -1 }] }).success).toBe(false);
    expect(domainRuleSchema.safeParse({
      id: "dom_docs",
      repositoryId: "repo",
      ...base,
      color: "#123456",
      position: 0,
      enabled: true,
      excludePatterns: [],
      createdAt: "not-a-date",
      updatedAt: "2026-09-15T00:00:00.000Z",
    }).success).toBe(false);
  });
});
