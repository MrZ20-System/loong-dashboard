import { describe, expect, it } from "vitest";

import {
  knowledgeCheckpointSettingsSchema,
  settingsDocumentV2Schema,
} from "../src/index.js";

const repository = {
  automaticSync: false,
  syncFrequencyMinutes: 60,
  syncLookbackDays: 30 as const,
  retention: {
    automaticArchiveEnabled: false,
    archiveAfterDays: 7,
    includeMergedPrs: true,
    includeClosedPrs: true,
    includeClosedIssues: true,
    prunePayloadWhenArchived: true,
  },
  worktrees: {
    configuredSlots: 1,
    idleCleanupTtlHours: 24,
  },
};

const document = {
  version: 2 as const,
  repositories: { vllm: repository },
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

describe("settings contracts", () => {
  it("accepts the complete strict V2 policy document", () => {
    expect(settingsDocumentV2Schema.parse(document)).toEqual(document);
  });

  it("rejects V2 unknown, missing, and malformed fields", () => {
    expect(settingsDocumentV2Schema.safeParse({ ...document, opaque: true }).success).toBe(false);
    const { agent: _agent, ...withoutAgent } = document;
    expect(settingsDocumentV2Schema.safeParse(withoutAgent).success).toBe(false);
    expect(settingsDocumentV2Schema.safeParse({
      ...document,
      repositories: { vllm: { ...repository, worktrees: { ...repository.worktrees, active: 1 } } },
    }).success).toBe(false);
    const { archiveRepositoryPath: _archiveRepositoryPath, ...withoutArchivePath } = document.agentArchive;
    expect(settingsDocumentV2Schema.safeParse({
      ...document,
      agentArchive: withoutArchivePath,
    }).success).toBe(false);
  });

  it("exposes only canonical Knowledge fields and rejects legacy aliases", () => {
    const canonical = {
      autoCommit: false,
      autoPush: false,
      remote: "origin",
      sourceRef: "main",
      remoteBranch: "loongboard-knowledge-backup",
      checkpointIntervalMinutes: null,
      pushIntervalMinutes: null,
    };
    expect(knowledgeCheckpointSettingsSchema.parse(canonical)).toEqual(canonical);
    expect(knowledgeCheckpointSettingsSchema.safeParse({
      ...canonical,
      branch: "main",
    }).success).toBe(false);
    expect(knowledgeCheckpointSettingsSchema.safeParse({
      ...canonical,
      intervalMinutes: null,
    }).success).toBe(false);
  });
});
