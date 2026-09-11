import { describe, expect, it } from "vitest";

import {
  agentSessionCreateSchema,
  agentSessionSummarySchema,
  agentSessionsQuerySchema,
} from "../src/index.js";

const scope = {
  kind: "pr" as const,
  repositoryId: "repo",
  prNumber: 5,
  targetSha: "a".repeat(40),
};

const summary = {
  id: "sess_1",
  scope,
  workspacePath: "/tmp/pr-worktree",
  dshHomePath: "/tmp/dsh-home",
  provider: "deepseek-official",
  model: "deepseek-v4-flash",
  reasoningEffort: "high",
  status: "idle" as const,
  dshSessionId: null,
  title: null,
  titleSource: "provisional" as const,
  createdAt: "2026-09-03T00:00:00.000Z",
  lastUsedAt: "2026-09-03T00:00:00.000Z",
};

describe("agent session contracts", () => {
  it("accepts the canonical scope and workspacePath fields", () => {
    expect(agentSessionCreateSchema.parse({ scope })).toEqual({ scope });
    expect(agentSessionSummarySchema.parse(summary)).toEqual(summary);
  });

  it("rejects origin/workspace projections and incomplete summaries", () => {
    expect(agentSessionCreateSchema.safeParse({
      scope,
      origin: scope,
    }).success).toBe(false);
    expect(agentSessionSummarySchema.safeParse({
      ...summary,
      workspace: { path: summary.workspacePath },
    }).success).toBe(false);
    const { titleSource: _titleSource, ...withoutTitleSource } = summary;
    expect(agentSessionSummarySchema.safeParse(withoutTitleSource).success).toBe(false);
    const { title: _title, ...withoutTitle } = summary;
    expect(agentSessionSummarySchema.safeParse(withoutTitle).success).toBe(false);
  });

  it("uses scopeKind for session discovery filters", () => {
    expect(agentSessionsQuerySchema.parse({ scopeKind: "pr" })).toEqual({ scopeKind: "pr" });
    expect(agentSessionsQuerySchema.safeParse({ originKind: "pr" }).success).toBe(false);
  });
});
