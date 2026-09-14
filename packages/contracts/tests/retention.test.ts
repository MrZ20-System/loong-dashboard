import { describe, expect, it } from "vitest";

import {
  archiveFilterSchema,
  archivePreviewRequestSchema,
  maintenanceRunKindSchema,
  repositoryRetentionSettingsSchema,
  repositorySettingsSchema,
  repositorySettingsUpdateSchema,
} from "../src/index.js";

describe("retention contracts", () => {
  it("defaults repository retention to safe manual, prune-on settings", () => {
    const settings = repositorySettingsSchema.parse({
      repositoryId: "repo",
      automaticSync: false,
      syncCron: "0 */1 * * *",
      syncLookbackDays: 30,
    });

    expect(settings.retention).toEqual({
      automaticArchiveEnabled: false,
      archiveAfterDays: 7,
      includeMergedPrs: true,
      includeClosedPrs: true,
      includeClosedIssues: true,
      prunePayloadWhenArchived: true,
    });
  });

  it("accepts partial retention upgrades but rejects unsafe day values", () => {
    expect(repositorySettingsUpdateSchema.parse({
      retention: { automaticArchiveEnabled: true, archiveAfterDays: 30 },
    })).toEqual({
      retention: { automaticArchiveEnabled: true, archiveAfterDays: 30 },
    });
    expect(repositoryRetentionSettingsSchema.safeParse({
      automaticArchiveEnabled: false,
      archiveAfterDays: 0,
      includeMergedPrs: true,
      includeClosedPrs: true,
      includeClosedIssues: true,
      prunePayloadWhenArchived: true,
    }).success).toBe(false);
    expect(repositorySettingsUpdateSchema.safeParse({ retention: {} }).success).toBe(false);
  });

  it("keeps archive filters and local-date requests explicit", () => {
    expect(archiveFilterSchema.parse("current")).toBe("current");
    expect(archiveFilterSchema.safeParse("merged").success).toBe(false);
    expect(archivePreviewRequestSchema.parse({ date: "2026-09-11" })).toEqual({
      date: "2026-09-11",
      includeMergedPrs: true,
      includeClosedPrs: true,
      includeClosedIssues: true,
    });
  });

  it("keeps maintenance operations limited to canonical archive and history purge", () => {
    expect(maintenanceRunKindSchema.parse("archive")).toBe("archive");
    expect(maintenanceRunKindSchema.parse("purge_runtime_history")).toBe("purge_runtime_history");
    expect(maintenanceRunKindSchema.safeParse("prune").success).toBe(false);
    expect(maintenanceRunKindSchema.safeParse("optimize").success).toBe(false);
  });
});
