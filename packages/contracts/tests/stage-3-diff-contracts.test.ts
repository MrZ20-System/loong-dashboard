import { describe, expect, it } from "vitest";

import {
  changedFileEntrySchema,
  fileContentQuerySchema,
  fileContentResponseSchema,
  fullShaSchema,
  localCommandResponseSchema,
  preparePullResponseSchema,
  pullRequestDetailSchema,
} from "../src/index.js";

const sha = "0123456789abcdef".repeat(2) + "01234567"; // 40 hex
const badSha = "z".repeat(40);

describe("diff workspace contracts", () => {
  it("parses a changed file entry with rename source and binary stats", () => {
    const renamed = {
      path: "src/b.ts",
      previousPath: "src/a.ts",
      changeType: "renamed",
      additions: 2,
      deletions: 1,
      binary: false,
    };
    expect(changedFileEntrySchema.parse(renamed)).toEqual(renamed);
    const binary = {
      path: "blob.bin", previousPath: null, changeType: "added", additions: null, deletions: null, binary: true,
    };
    expect(changedFileEntrySchema.parse(binary)).toEqual(binary);
    expect(changedFileEntrySchema.safeParse({ ...renamed, changeType: "unknown" }).success).toBe(false);
    expect(changedFileEntrySchema.safeParse({ ...renamed, extra: true }).success).toBe(false);
  });

  it("parses the prepare response and validates full 40-hex SHAs", () => {
    const prepared = {
      repositoryId: "repo", number: 42, headSha: sha, mergeBase: sha, fetched: true, files: [],
    };
    expect(preparePullResponseSchema.parse(prepared)).toEqual(prepared);
    expect(preparePullResponseSchema.safeParse({ ...prepared, headSha: badSha }).success).toBe(false);
    expect(preparePullResponseSchema.safeParse({ ...prepared, fetched: "yes" }).success).toBe(false);
  });

  it("validates the file query path stays inside the repository tree", () => {
    expect(fileContentQuerySchema.parse({ path: "src/a.ts", ref: sha })).toEqual({ path: "src/a.ts", ref: sha });
    expect(fileContentQuerySchema.safeParse({ path: "../escape", ref: sha }).success).toBe(false);
    expect(fileContentQuerySchema.safeParse({ path: "/etc/passwd", ref: sha }).success).toBe(false);
    expect(fileContentQuerySchema.safeParse({ path: "a\\b", ref: sha }).success).toBe(false);
    expect(fileContentQuerySchema.safeParse({ path: "src/a.ts", ref: badSha }).success).toBe(false);
    expect(fullShaSchema.safeParse("a".repeat(39)).success).toBe(false);
  });

  it("parses file content responses including the two degradation branches", () => {
    expect(fileContentResponseSchema.parse({ path: "a.ts", ref: sha, binary: false, tooLarge: false, sizeBytes: 5, content: "hello" })).toMatchObject({ content: "hello" });
    expect(fileContentResponseSchema.parse({ path: "a.bin", ref: sha, binary: true, tooLarge: false, sizeBytes: 9, content: null })).toMatchObject({ binary: true });
    expect(fileContentResponseSchema.safeParse({ path: "a.ts", ref: sha, binary: false, tooLarge: false, sizeBytes: 5, content: null }).success).toBe(true);
    const command = ["git", "fetch", "origin", "pull/1/head:pr-1", "&&", "git", "switch", "pr-1"].join(" ");
    expect(localCommandResponseSchema.parse({ command }).command.length).toBeGreaterThan(0);
  });

  it("parses the stored PR detail used by the diff header", () => {
    const base = {
      repositoryId: "repo", number: 42, title: "t", url: "https://github.com/a/b/pull/42",
      authorLogin: "u", status: "open", updatedAt: "2026-09-03T01:00:00.000Z",
      changedFilesCount: 1, additions: 1, deletions: 0, domains: [],
      createdAt: "2026-09-03T00:00:00.000Z", closedAt: null, mergedAt: null,
      baseRefName: "main", headRefName: "feat", headSha: sha, detailBody: null,
    };
    expect(pullRequestDetailSchema.parse(base)).toEqual(base);
    expect(pullRequestDetailSchema.safeParse({ ...base, headSha: badSha }).success).toBe(false);
    expect(pullRequestDetailSchema.safeParse({ ...base, status: "merged", mergedAt: "2026-09-03T02:00:00.000Z" }).success).toBe(true);
  });
});
