import { describe, expect, it } from "vitest";

import {
  historyResponseSchema,
  historySettingsSchema,
} from "../src/index.js";

const pullRequestSettings = {
  repositoryId: "repo",
  entityKind: "pull_request" as const,
  targetDate: null,
  oldestCoveredDay: null,
  cursor: null,
  enabled: true,
  status: "idle" as const,
  lastRunId: null,
  lastError: null,
  updatedAt: "2026-09-10T00:00:00.000Z",
};

describe("history sync contracts", () => {
  it("requires entityKind on every history settings row", () => {
    expect(historySettingsSchema.parse(pullRequestSettings)).toEqual(pullRequestSettings);
    const withoutEntityKind = { ...pullRequestSettings };
    delete (withoutEntityKind as { entityKind?: unknown }).entityKind;
    expect(historySettingsSchema.safeParse(withoutEntityKind).success).toBe(false);
  });

  it("keeps PR and Issue history settings distinguishable in one response", () => {
    const response = historyResponseSchema.parse({
      settings: [
        pullRequestSettings,
        { ...pullRequestSettings, entityKind: "issue" as const },
      ],
    });
    expect(response.settings.map((item) => item.entityKind)).toEqual([
      "pull_request",
      "issue",
    ]);
  });
});
