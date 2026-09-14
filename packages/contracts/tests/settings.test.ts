import { describe, expect, it } from "vitest";

import {
  codeBackupSettingsSchema,
  knowledgeCheckpointSettingsSchema,
  settingsDocumentV2Schema,
  settingsDocumentV3Schema,
  settingsDocumentV4Schema,
} from "../src/index.js";

const retention = {
  automaticArchiveEnabled: false,
  archiveAfterDays: 7,
  includeMergedPrs: true,
  includeClosedPrs: true,
  includeClosedIssues: true,
  prunePayloadWhenArchived: true,
};

const v2Document = {
  version: 2 as const,
  repositories: {
    vllm: {
      automaticSync: false,
      syncFrequencyMinutes: 60,
      syncLookbackDays: 30 as const,
      retention,
      worktrees: { configuredSlots: 1, idleCleanupTtlHours: 24 },
    },
  },
  github: {
    verifiedSource: null,
    account: null,
    rest: null,
    graphql: null,
    lastVerifiedAt: null,
  },
  agent: {
    defaultProvider: null,
    defaultModel: null,
    defaultReasoning: null,
    retentionMinutes: 120,
  },
  knowledgeBackup: {
    autoCommit: false,
    autoPush: false,
    remote: "origin",
    sourceRef: "main",
    remoteBranch: "loongboard-knowledge-backup",
    checkpointIntervalMinutes: null,
    pushIntervalMinutes: null,
  },
  codeBackup: {
    automaticCheckpoint: false,
    checkpointIntervalMinutes: null,
    automaticPush: false,
    pushIntervalMinutes: null,
    sourceRef: "main",
    remote: "origin",
    remoteBranch: "loongboard-backup",
  },
  agentArchive: {
    archiveRepositoryPath: "agent-archive",
    enabled: false,
    exportIntervalMinutes: null,
    automaticPush: false,
    pushIntervalMinutes: null,
    sourceRef: "main",
    remote: "origin",
    remoteBranch: "agent-history-backup",
  },
};

const v3Document = {
  version: 3 as const,
  repositories: {
    vllm: {
      automaticSync: false,
      syncCron: "0 */1 * * *",
      syncLookbackDays: 30 as const,
      retention,
      worktrees: { configuredSlots: 1, idleCleanupTtlHours: 24 },
    },
  },
  github: v2Document.github,
  agent: v2Document.agent,
  knowledgeBackup: {
    autoCommit: false,
    autoPush: false,
    remote: "origin",
    sourceRef: "main",
    remoteBranch: "loongboard-knowledge-backup",
    checkpointCron: "0 0 * * *",
    pushCron: "0 0 * * *",
  },
  codeBackup: {
    automaticCheckpoint: false,
    checkpointCron: "0 0 * * *",
    automaticPush: false,
    pushCron: "0 0 * * *",
    sourceRef: "main",
    remote: "origin",
    remoteBranch: "loongboard-backup",
  },
  agentArchive: {
    archiveRepositoryPath: "agent-archive",
    enabled: false,
    exportCron: "0 0 * * *",
    automaticPush: false,
    pushCron: "0 0 * * *",
    sourceRef: "main",
    remote: "origin",
    remoteBranch: "agent-history-backup",
  },
};

const v4Document = {
  version: 4 as const,
  repositories: v3Document.repositories,
  github: v3Document.github,
  agent: v3Document.agent,
  personalDataBackup: {
    automaticCheckpoint: false,
    checkpointCron: "0 0 * * *",
    automaticPush: false,
    pushCron: "0 0 * * *",
    sourceRef: "main",
    remote: "origin",
    remoteBranch: "loongboard-personal-data-backup",
  },
  codeBackup: v3Document.codeBackup,
  agentArchive: v3Document.agentArchive,
};

describe("settings contracts", () => {
  it("accepts strict V2 migration input and strict V3 runtime policy", () => {
    expect(settingsDocumentV2Schema.parse(v2Document)).toEqual(v2Document);
    expect(settingsDocumentV3Schema.parse(v3Document)).toEqual(v3Document);
  });

  it("accepts only the canonical V4 Personal Data backup policy", () => {
    expect(settingsDocumentV4Schema.parse(v4Document)).toEqual(v4Document);
    expect(settingsDocumentV4Schema.safeParse({
      ...v4Document,
      knowledgeBackup: v3Document.knowledgeBackup,
    }).success).toBe(false);
    expect(settingsDocumentV4Schema.safeParse({
      ...v4Document,
      personalDataBackup: {
        ...v4Document.personalDataBackup,
        checkpointCron: null,
      },
    }).success).toBe(false);
  });

  it("rejects legacy cadence fields from V3 policy", () => {
    expect(settingsDocumentV3Schema.safeParse({
      ...v3Document,
      knowledgeBackup: {
        ...v3Document.knowledgeBackup,
        checkpointIntervalMinutes: 30,
      },
    }).success).toBe(false);
  });

  it("requires valid-looking non-empty Cron strings even when schedules are disabled", () => {
    expect(knowledgeCheckpointSettingsSchema.parse({
      autoCommit: false,
      autoPush: false,
      remote: "origin",
      sourceRef: "main",
      remoteBranch: "loongboard-knowledge-backup",
      checkpointCron: "0 0 * * *",
      pushCron: "0 0 * * *",
    })).toMatchObject({ checkpointCron: "0 0 * * *", pushCron: "0 0 * * *" });
    expect(knowledgeCheckpointSettingsSchema.safeParse({
      autoCommit: false,
      autoPush: false,
      remote: "origin",
      sourceRef: "main",
      remoteBranch: "loongboard-knowledge-backup",
      checkpointCron: null,
      pushCron: "0 0 * * *",
    }).success).toBe(false);
  });

  it("keeps Code backup availability runtime-only", () => {
    const projection = codeBackupSettingsSchema.parse({
      repositoryPath: "/checkout",
      available: false,
      ...v3Document.codeBackup,
      lastCheckpointAt: null,
      nextCheckpointAt: null,
      lastPushAt: null,
      nextPushAt: null,
      lastError: null,
    });
    expect(projection.available).toBe(false);
    expect(settingsDocumentV3Schema.safeParse({
      ...v3Document,
      codeBackup: { ...v3Document.codeBackup, available: false },
    }).success).toBe(false);
  });
});
