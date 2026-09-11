import {
  settingsDocumentV2Schema,
  type SettingsDocumentV2,
} from "@loongboard/contracts";

export interface SettingsDocumentRepositoryDefaults {
  configuredSlots?: number;
  idleCleanupTtlHours?: number;
}

export interface SettingsDocumentDefaults {
  repositories?: Record<string, SettingsDocumentRepositoryDefaults>;
  agent?: {
    defaultProvider?: string | null;
    defaultModel?: string | null;
    defaultReasoning?: string | null;
    retentionMinutes?: number;
  };
  knowledgeBackup?: Partial<SettingsDocumentV2["knowledgeBackup"]>;
  codeBackup?: Partial<SettingsDocumentV2["codeBackup"]>;
  agentArchive?: Partial<SettingsDocumentV2["agentArchive"]>;
}

const DEFAULT_RETENTION = {
  automaticArchiveEnabled: false,
  archiveAfterDays: 7,
  includeMergedPrs: true,
  includeClosedPrs: true,
  includeClosedIssues: true,
  prunePayloadWhenArchived: true,
} as const;

const DEFAULTS: SettingsDocumentV2 = {
  version: 2,
  repositories: {},
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
    archiveRepositoryPath: "agent-history",
    enabled: false,
    exportIntervalMinutes: null,
    automaticPush: false,
    pushIntervalMinutes: null,
    sourceRef: "main",
    remote: "origin",
    remoteBranch: "agent-history-backup",
  },
};

/**
 * Build a complete V2 document from installation defaults. This is also the
 * missing-file path; callers should write the returned value immediately.
 */
export function createDefaultSettingsDocument(
  options: SettingsDocumentDefaults = {},
): SettingsDocumentV2 {
  return migrateSettingsV1ToV2(undefined, options);
}

/**
 * Convert the only supported legacy input (V1 or an absent document) into the
 * complete V2 policy document. Compatibility is intentionally confined here:
 * unknown fields and runtime projections are discarded during migration.
 */
export function migrateSettingsV1ToV2(
  raw: unknown,
  options: SettingsDocumentDefaults = {},
): SettingsDocumentV2 {
  if (raw !== undefined && !isRecord(raw)) {
    throw new Error("settings.json must contain an object");
  }
  const source = raw ?? {};
  const version = source.version;
  if (version !== undefined && version !== 1 && version !== 2) {
    throw new Error(`Unsupported settings.json version: ${String(version)}`);
  }
  if (version === 2) {
    return settingsDocumentV2Schema.parse(source);
  }

  const repositories = migrateRepositories(source.repositories, options.repositories);
  const github = migrateGithub(source.github);
  const agentSource = asRecord(source.agent);
  const agent = {
    defaultProvider: readNullableString(
      agentSource.defaultProvider,
      options.agent?.defaultProvider ?? DEFAULTS.agent.defaultProvider,
    ),
    defaultModel: readNullableString(
      agentSource.defaultModel,
      options.agent?.defaultModel ?? DEFAULTS.agent.defaultModel,
    ),
    defaultReasoning: readNullableString(
      agentSource.defaultReasoning,
      options.agent?.defaultReasoning ?? DEFAULTS.agent.defaultReasoning,
    ),
    retentionMinutes: readNonNegativeInteger(
      agentSource.retentionMinutes,
      options.agent?.retentionMinutes ?? DEFAULTS.agent.retentionMinutes,
    ),
  };

  const checkpointSource = isRecord(source.knowledgeBackup)
    ? source.knowledgeBackup
    : asRecord(source.checkpoint);
  const knowledgeBackup = migrateKnowledgeBackup(
    checkpointSource,
    options.knowledgeBackup,
  );
  const codeBackup = migrateCodeBackup(
    asRecord(source.codeBackup),
    options.codeBackup,
  );
  const agentArchive = migrateAgentArchive(
    asRecord(source.agentArchive),
    options.agentArchive,
  );

  return settingsDocumentV2Schema.parse({
    version: 2,
    repositories,
    github,
    agent,
    knowledgeBackup,
    codeBackup,
    agentArchive,
  });
}

function migrateRepositories(
  value: unknown,
  defaults: SettingsDocumentDefaults["repositories"],
): SettingsDocumentV2["repositories"] {
  const source = asRecord(value);
  const ids = new Set([
    ...Object.keys(defaults ?? {}),
    ...Object.keys(source),
  ]);
  const repositories: SettingsDocumentV2["repositories"] = {};
  for (const id of ids) {
    const stored = asRecord(source[id]);
    const repositoryDefaults = defaults?.[id] ?? {};
    repositories[id] = {
      automaticSync: readBoolean(stored.automaticSync, false),
      syncFrequencyMinutes: readPositiveInteger(stored.syncFrequencyMinutes, 60),
      syncLookbackDays: stored.syncLookbackDays === 7 ? 7 : 30,
      retention: {
        automaticArchiveEnabled: readBoolean(
          asRecord(stored.retention).automaticArchiveEnabled,
          DEFAULT_RETENTION.automaticArchiveEnabled,
        ),
        archiveAfterDays: readBoundedInteger(
          asRecord(stored.retention).archiveAfterDays,
          DEFAULT_RETENTION.archiveAfterDays,
          1,
          3650,
        ),
        includeMergedPrs: readBoolean(
          asRecord(stored.retention).includeMergedPrs,
          DEFAULT_RETENTION.includeMergedPrs,
        ),
        includeClosedPrs: readBoolean(
          asRecord(stored.retention).includeClosedPrs,
          DEFAULT_RETENTION.includeClosedPrs,
        ),
        includeClosedIssues: readBoolean(
          asRecord(stored.retention).includeClosedIssues,
          DEFAULT_RETENTION.includeClosedIssues,
        ),
        prunePayloadWhenArchived: readBoolean(
          asRecord(stored.retention).prunePayloadWhenArchived,
          DEFAULT_RETENTION.prunePayloadWhenArchived,
        ),
      },
      worktrees: {
        configuredSlots: readBoundedInteger(
          asRecord(stored.worktrees).configuredSlots,
          repositoryDefaults.configuredSlots ?? 1,
          1,
          8,
        ),
        idleCleanupTtlHours: readBoundedInteger(
          asRecord(stored.worktrees).idleCleanupTtlHours,
          repositoryDefaults.idleCleanupTtlHours ?? 24,
          1,
          24 * 365,
        ),
      },
    };
  }
  return repositories;
}

function migrateGithub(value: unknown): SettingsDocumentV2["github"] {
  const source = asRecord(value);
  const accountSource = asRecord(source.account);
  const account = typeof accountSource.login === "string" && accountSource.login.trim().length > 0
    ? {
        login: accountSource.login,
        name: accountSource.name === null || typeof accountSource.name === "string"
          ? accountSource.name
          : null,
      }
    : null;
  return {
    verifiedSource: isCredentialSource(source.verifiedSource)
      ? source.verifiedSource
      : null,
    account,
    rest: migrateQuota(source.rest),
    graphql: migrateQuota(source.graphql),
    lastVerifiedAt: readNullableString(source.lastVerifiedAt, null),
  };
}

function migrateQuota(value: unknown): SettingsDocumentV2["github"]["rest"] {
  const source = asRecord(value);
  if (
    !Number.isInteger(source.remaining) || (source.remaining as number) < 0 ||
    !Number.isInteger(source.limit) || (source.limit as number) <= 0 ||
    !(source.resetAt === null || typeof source.resetAt === "string")
  ) {
    return null;
  }
  return {
    remaining: source.remaining as number,
    limit: source.limit as number,
    resetAt: source.resetAt as string | null,
  };
}

function migrateKnowledgeBackup(
  value: Record<string, unknown>,
  defaults: SettingsDocumentDefaults["knowledgeBackup"],
): SettingsDocumentV2["knowledgeBackup"] {
  return {
    autoCommit: readBoolean(value.autoCommit, defaults?.autoCommit ?? DEFAULTS.knowledgeBackup.autoCommit),
    autoPush: readBoolean(value.autoPush, defaults?.autoPush ?? DEFAULTS.knowledgeBackup.autoPush),
    remote: readString(value.remote, defaults?.remote ?? DEFAULTS.knowledgeBackup.remote),
    sourceRef: readString(
      value.sourceRef,
      readString(value.branch, defaults?.sourceRef ?? DEFAULTS.knowledgeBackup.sourceRef),
    ),
    remoteBranch: readString(value.remoteBranch, defaults?.remoteBranch ?? DEFAULTS.knowledgeBackup.remoteBranch),
    checkpointIntervalMinutes: readNullablePositiveInteger(
      value.checkpointIntervalMinutes,
      readNullablePositiveInteger(value.intervalMinutes, defaults?.checkpointIntervalMinutes ?? DEFAULTS.knowledgeBackup.checkpointIntervalMinutes),
    ),
    pushIntervalMinutes: readNullablePositiveInteger(
      value.pushIntervalMinutes,
      defaults?.pushIntervalMinutes ?? DEFAULTS.knowledgeBackup.pushIntervalMinutes,
    ),
  };
}

function migrateCodeBackup(
  value: Record<string, unknown>,
  defaults: SettingsDocumentDefaults["codeBackup"],
): SettingsDocumentV2["codeBackup"] {
  return {
    automaticCheckpoint: readBoolean(value.automaticCheckpoint, defaults?.automaticCheckpoint ?? DEFAULTS.codeBackup.automaticCheckpoint),
    checkpointIntervalMinutes: readNullablePositiveInteger(value.checkpointIntervalMinutes, defaults?.checkpointIntervalMinutes ?? DEFAULTS.codeBackup.checkpointIntervalMinutes),
    automaticPush: readBoolean(value.automaticPush, defaults?.automaticPush ?? DEFAULTS.codeBackup.automaticPush),
    pushIntervalMinutes: readNullablePositiveInteger(value.pushIntervalMinutes, defaults?.pushIntervalMinutes ?? DEFAULTS.codeBackup.pushIntervalMinutes),
    sourceRef: readString(value.sourceRef, defaults?.sourceRef ?? DEFAULTS.codeBackup.sourceRef),
    remote: readString(value.remote, defaults?.remote ?? DEFAULTS.codeBackup.remote),
    remoteBranch: readString(value.remoteBranch, defaults?.remoteBranch ?? DEFAULTS.codeBackup.remoteBranch),
  };
}

function migrateAgentArchive(
  value: Record<string, unknown>,
  defaults: SettingsDocumentDefaults["agentArchive"],
): SettingsDocumentV2["agentArchive"] {
  return {
    archiveRepositoryPath: readString(
      value.archiveRepositoryPath,
      defaults?.archiveRepositoryPath ?? DEFAULTS.agentArchive.archiveRepositoryPath,
    ),
    enabled: readBoolean(value.enabled, defaults?.enabled ?? DEFAULTS.agentArchive.enabled),
    exportIntervalMinutes: readNullablePositiveInteger(value.exportIntervalMinutes, defaults?.exportIntervalMinutes ?? DEFAULTS.agentArchive.exportIntervalMinutes),
    automaticPush: readBoolean(value.automaticPush, defaults?.automaticPush ?? DEFAULTS.agentArchive.automaticPush),
    pushIntervalMinutes: readNullablePositiveInteger(value.pushIntervalMinutes, defaults?.pushIntervalMinutes ?? DEFAULTS.agentArchive.pushIntervalMinutes),
    sourceRef: readString(value.sourceRef, defaults?.sourceRef ?? DEFAULTS.agentArchive.sourceRef),
    remote: readString(value.remote, defaults?.remote ?? DEFAULTS.agentArchive.remote),
    remoteBranch: readString(value.remoteBranch, defaults?.remoteBranch ?? DEFAULTS.agentArchive.remoteBranch),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function readNullableString(value: unknown, fallback: string | null): string | null {
  if (value === null) return null;
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function readPositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function readNonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function readBoundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const candidate = typeof value === "number" && Number.isInteger(value) ? value : fallback;
  return Math.min(maximum, Math.max(minimum, candidate));
}

function readNullablePositiveInteger(
  value: unknown,
  fallback: number | null = null,
): number | null {
  if (value === null) return null;
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function isCredentialSource(value: unknown): value is SettingsDocumentV2["github"]["verifiedSource"] {
  return value === "settings" ||
    value === "GH_TOKEN" ||
    value === "GITHUB_TOKEN" ||
    value === "gh" ||
    value === "none";
}
