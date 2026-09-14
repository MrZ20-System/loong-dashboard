import { describe, expect, it } from "vitest";

import {
  personalDataImportSchema,
  personalDataInstructionTreeRefreshResponseSchema,
  personalDataStatusSchema,
} from "../src/index.js";

describe("personal data contracts", () => {
  it("requires a repository URL and non-empty branch", () => {
    expect(personalDataImportSchema.parse({
      repositoryUrl: "https://github.com/example/personal-data.git",
      branch: "profile/z20",
    })).toEqual({
      repositoryUrl: "https://github.com/example/personal-data.git",
      branch: "profile/z20",
    });
    expect(personalDataImportSchema.safeParse({
      repositoryUrl: "https://github.com/example/personal-data.git",
      branch: "   ",
    }).success).toBe(false);
    expect(personalDataImportSchema.safeParse({
      repositoryUrl: "https://github.com/example/personal-data.git",
      branch: "main",
      path: "/tmp/personal-data",
    }).success).toBe(false);
  });

  it("keeps status paths read-only and validates refresh output", () => {
    expect(personalDataStatusSchema.parse({
      path: "/data/personal-data",
      knowledgePath: "/data/personal-data/knowledge",
      instructionTreePath: "/data/personal-data/knowledge/_loongboard/instruction-tree.md",
      available: true,
    }).available).toBe(true);
    expect(personalDataInstructionTreeRefreshResponseSchema.parse({
      path: "/data/personal-data/knowledge/_loongboard/instruction-tree.md",
      updatedAt: "2026-09-14T00:00:00.000Z",
    }).path).toContain("instruction-tree.md");
  });
});
