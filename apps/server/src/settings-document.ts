import {
  settingsDocumentV2Schema,
  settingsDocumentV3Schema,
  settingsDocumentV4Schema,
  type SettingsDocumentV2,
  type SettingsDocumentV3,
  type SettingsDocumentV4,
} from "@loongboard/contracts";
import { validateCron } from "@loongboard/scheduler";

import { legacyIntervalToCron } from "./legacy-schedule-migration.js";

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
  knowledgeBackup?: Partial<SettingsDocumentV3["knowledgeBackup"]>;
  personalDataBackup?: Partial<SettingsDocumentV4["personalDataBackup"]>;
  codeBackup?: Partial<SettingsDocumentV3["codeBackup"]>;
  agentArchive?: Partial<SettingsDocumentV3["agentArchive"]>;
}

/** Existing runtime projections used to recover the effective V2 cadence. */
export interface SettingsDocumentScheduleOverrides {
  repositorySyncCron?: Readonly<Record<string, string>>;
  knowledgeCheckpointCron?: string;
  knowledgePushCron?: string;
  personalDataCheckpointCron?: string;
  personalDataPushCron?: string;
  codeCheckpointCron?: string;
  codePushCron?: string;
  agentArchiveExportCron?: string;
  agentArchivePushCron?: string;
}

const DEFAULT_RETENTION = {
  automaticArchiveEnabled: false,
  archiveAfterDays: 7,
  includeMergedPrs: true,
  includeClosedPrs: true,
  includeClosedIssues: true,
  prunePayloadWhenArchived: true,
} as const;

const DEFAULT_CRON = "0 0 * * *";
const DEFAULT_SYNC_CRON = "0 */1 * * *";

const DEFAULTS: SettingsDocumentV3 = {
  version: 3,
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
    checkpointCron: DEFAULT_CRON,
    pushCron: DEFAULT_CRON,
  },
  codeBackup: {
    automaticCheckpoint: false,
    checkpointCron: DEFAULT_CRON,
    automaticPush: false,
    pushCron: DEFAULT_CRON,
    sourceRef: "main",
    remote: "origin",
    remoteBranch: "loongboard-backup",
  },
  agentArchive: {
    archiveRepositoryPath: "agent-history",
    enabled: false,
    exportCron: DEFAULT_CRON,
    automaticPush: false,
    pushCron: DEFAULT_CRON,
    sourceRef: "main",
    remote: "origin",
    remoteBranch: "agent-history-backup",
  },
};

const DEFAULTS_V4: SettingsDocumentV4 = {
  version: 4,
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
  personalDataBackup: {
    automaticCheckpoint: false,
    checkpointCron: DEFAULT_CRON,
    automaticPush: false,
    pushCron: DEFAULT_CRON,
    sourceRef: "main",
    remote: "origin",
    remoteBranch: "loongboard-personal-data-backup",
  },
  codeBackup: DEFAULTS.codeBackup,
  agentArchive: DEFAULTS.agentArchive,
};

/** Build a complete V3 document from installation defaults. */
export function createDefaultSettingsDocument(
  options: SettingsDocumentDefaults = {},
): SettingsDocumentV3 {
  return migrateSettingsToV3(undefined, options);
}

/**
 * Migrate the only supported legacy document versions into the runtime V3
 * policy. Version conversion is deliberately isolated to this module: the
 * Settings controller and all runtime adapters only consume V3.
 */
export function migrateSettingsToV3(
  raw: unknown,
  options: SettingsDocumentDefaults = {},
  schedules: SettingsDocumentScheduleOverrides = {},
): SettingsDocumentV3 {
  if (raw !== undefined && !isRecord(raw)) {
    throw new Error("settings.json must contain an object");
  }
  const source = raw ?? {};
  const version = source.version;
  if (version !== undefined && version !== 1 && version !== 2 && version !== 3) {
    throw new Error(`Unsupported settings.json version: ${String(version)}`);
  }
  if (version === 3) {
    return validateSettingsDocumentCrons(settingsDocumentV3Schema.parse(source));
  }
  if (version === 2) {
    return migrateSettingsV2ToV3(source, options, schedules);
  }
  return migrateSettingsV1ToV3(source, options, schedules);
}

/** Build the complete durable V4 document consumed by the runtime. */
export function createDefaultSettingsDocumentV4(
  options: SettingsDocumentDefaults = {},
): SettingsDocumentV4 {
  return migrateSettingsToV4(undefined, options);
}

/**
 * Migrate every supported durable input directly to Settings V4.  V2/V3
 * shapes are accepted only here; callers that run the server receive the
 * strict V4 result and never have to branch on a legacy field name.
 */
export function migrateSettingsToV4(
  raw: unknown,
  options: SettingsDocumentDefaults = {},
  schedules: SettingsDocumentScheduleOverrides = {},
): SettingsDocumentV4 {
  if (raw !== undefined && !isRecord(raw)) {
    throw new Error("settings.json must contain an object");
  }
  const source = raw ?? {};
  const version = source.version;
  if (version !== undefined && version !== 1 && version !== 2 && version !== 3 && version !== 4) {
    throw new Error(`Unsupported settings.json version: ${String(version)}`);
  }
  if (version === 4) {
    return validateSettingsDocumentV4Crons(settingsDocumentV4Schema.parse(source));
  }
  const v3 = version === 3
    ? settingsDocumentV3Schema.parse(source)
    : version === 2
      ? migrateSettingsV2ToV3(source, options, schedules)
      : migrateSettingsV1ToV3(source, options, schedules);
  const migrated = migrateSettingsV3ToV4(v3, options, schedules);
  if (raw === undefined) {
    // A missing document is a fresh V4 installation.  V1/V3 migration
    // defaults intentionally retain the old knowledge branch for historical
    // callers, so apply the canonical Personal Data defaults only here.
    const personalDataDefaults = options.personalDataBackup ?? {};
    const personalDataBackup = {
      ...migrated.personalDataBackup,
      ...Object.fromEntries(
        Object.entries(personalDataDefaults).filter(([, value]) => value !== undefined),
      ),
      remoteBranch:
        personalDataDefaults.remoteBranch ??
        DEFAULTS_V4.personalDataBackup.remoteBranch,
    };
    return validateSettingsDocumentV4Crons(
      settingsDocumentV4Schema.parse({ ...migrated, personalDataBackup }),
    );
  }
  return migrated;
}

/** Convert the V3 knowledge-named policy to the canonical V4 policy. */
export function migrateSettingsV3ToV4(
  raw: SettingsDocumentV3,
  options: SettingsDocumentDefaults = {},
  schedules: SettingsDocumentScheduleOverrides = {},
): SettingsDocumentV4 {
  const source = settingsDocumentV3Schema.parse(raw);
  const legacy = source.knowledgeBackup;
  const personalDataBackup = {
    // V3 is an existing user document.  Preserve every durable policy value;
    // defaults are only for missing/absent documents, never for migration of
    // a field that V3 already required.
    automaticCheckpoint: legacy.autoCommit,
    checkpointCron:
      schedules.personalDataCheckpointCron ??
      schedules.knowledgeCheckpointCron ??
      legacy.checkpointCron,
    automaticPush: legacy.autoPush,
    pushCron:
      schedules.personalDataPushCron ??
      schedules.knowledgePushCron ??
      legacy.pushCron,
    sourceRef: legacy.sourceRef,
    remote: legacy.remote,
    remoteBranch: legacy.remoteBranch,
  };
  return validateSettingsDocumentV4Crons(
    settingsDocumentV4Schema.parse({
      version: 4,
      repositories: source.repositories,
      github: source.github,
      agent: source.agent,
      personalDataBackup,
      codeBackup: source.codeBackup,
      agentArchive: source.agentArchive,
    }),
  );
}

/** Migrate a strict V2 document, preferring persisted task projections. */
export function migrateSettingsV2ToV3(
  raw: unknown,
  options: SettingsDocumentDefaults = {},
  schedules: SettingsDocumentScheduleOverrides = {},
): SettingsDocumentV3 {
  const source = settingsDocumentV2Schema.parse(raw);
  return validateSettingsDocumentCrons(
    migrateLegacyDocument(source, options, schedules),
  );
}

/** Migrate an old/absent V1 document while dropping runtime projections. */
export function migrateSettingsV1ToV3(
  raw: unknown,
  options: SettingsDocumentDefaults = {},
  schedules: SettingsDocumentScheduleOverrides = {},
): SettingsDocumentV3 {
  if (raw !== undefined && !isRecord(raw)) {
    throw new Error("settings.json must contain an object");
  }
  const source = raw ?? {};
  const repositories = migrateRepositories(source.repositories, options.repositories, schedules);
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
    schedules,
  );
  const codeBackup = migrateCodeBackup(
    asRecord(source.codeBackup),
    options.codeBackup,
    schedules,
  );
  const agentArchive = migrateAgentArchive(
    asRecord(source.agentArchive),
    options.agentArchive,
    schedules,
  );

  return validateSettingsDocumentCrons(
    settingsDocumentV3Schema.parse({
      version: 3,
      repositories,
      github,
      agent,
      knowledgeBackup,
      codeBackup,
      agentArchive,
    }),
  );
}

function migrateLegacyDocument(
  source: SettingsDocumentV2,
  options: SettingsDocumentDefaults,
  schedules: SettingsDocumentScheduleOverrides,
): SettingsDocumentV3 {
  const repositories: SettingsDocumentV3["repositories"] = {};
  for (const [id, stored] of Object.entries(source.repositories)) {
    repositories[id] = {
      automaticSync: stored.automaticSync,
      syncCron: resolveCron(
        schedules.repositorySyncCron?.[id],
        stored.syncFrequencyMinutes,
        DEFAULT_SYNC_CRON,
      ),
      syncLookbackDays: stored.syncLookbackDays,
      retention: stored.retention,
      worktrees: stored.worktrees,
    };
  }

  return settingsDocumentV3Schema.parse({
    version: 3,
    repositories: {
      ...migrateRepositories({}, options.repositories, schedules),
      ...repositories,
    },
    github: source.github,
    agent: source.agent,
    knowledgeBackup: {
      autoCommit: source.knowledgeBackup.autoCommit,
      autoPush: source.knowledgeBackup.autoPush,
      remote: source.knowledgeBackup.remote,
      sourceRef: source.knowledgeBackup.sourceRef,
      remoteBranch: source.knowledgeBackup.remoteBranch,
      checkpointCron: resolveCron(
        schedules.knowledgeCheckpointCron,
        source.knowledgeBackup.checkpointIntervalMinutes,
        options.knowledgeBackup?.checkpointCron ?? DEFAULT_CRON,
      ),
      pushCron: resolveCron(
        schedules.knowledgePushCron,
        source.knowledgeBackup.pushIntervalMinutes,
        options.knowledgeBackup?.pushCron ?? DEFAULT_CRON,
      ),
    },
    codeBackup: {
      automaticCheckpoint: source.codeBackup.automaticCheckpoint,
      automaticPush: source.codeBackup.automaticPush,
      sourceRef: source.codeBackup.sourceRef,
      remote: source.codeBackup.remote,
      remoteBranch: source.codeBackup.remoteBranch,
      checkpointCron: resolveCron(
        schedules.codeCheckpointCron,
        source.codeBackup.checkpointIntervalMinutes,
        options.codeBackup?.checkpointCron ?? DEFAULT_CRON,
      ),
      pushCron: resolveCron(
        schedules.codePushCron,
        source.codeBackup.pushIntervalMinutes,
        options.codeBackup?.pushCron ?? DEFAULT_CRON,
      ),
    },
    agentArchive: {
      archiveRepositoryPath: source.agentArchive.archiveRepositoryPath,
      enabled: source.agentArchive.enabled,
      automaticPush: source.agentArchive.automaticPush,
      sourceRef: source.agentArchive.sourceRef,
      remote: source.agentArchive.remote,
      remoteBranch: source.agentArchive.remoteBranch,
      exportCron: resolveCron(
        schedules.agentArchiveExportCron,
        source.agentArchive.exportIntervalMinutes,
        options.agentArchive?.exportCron ?? DEFAULT_CRON,
      ),
      pushCron: resolveCron(
        schedules.agentArchivePushCron,
        source.agentArchive.pushIntervalMinutes,
        options.agentArchive?.pushCron ?? DEFAULT_CRON,
      ),
    },
  });
}

function migrateRepositories(
  value: unknown,
  defaults: SettingsDocumentDefaults["repositories"],
  schedules: SettingsDocumentScheduleOverrides,
): SettingsDocumentV3["repositories"] {
  const source = asRecord(value);
  const ids = new Set([
    ...Object.keys(defaults ?? {}),
    ...Object.keys(source),
  ]);
  const repositories: SettingsDocumentV3["repositories"] = {};
  for (const id of ids) {
    const stored = asRecord(source[id]);
    const repositoryDefaults = defaults?.[id] ?? {};
    const legacyMinutes = readPositiveInteger(stored.syncFrequencyMinutes, 60);
    repositories[id] = {
      automaticSync: readBoolean(stored.automaticSync, false),
      syncCron: resolveCron(
        schedules.repositorySyncCron?.[id],
        legacyMinutes,
        DEFAULT_SYNC_CRON,
      ),
      syncLookbackDays: stored.syncLookbackDays === 30 ? 30 : 7,
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
          repositoryDefaults.configuredSlots ?? 10,
          1,
          16,
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

function migrateGithub(value: unknown): SettingsDocumentV3["github"] {
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

function migrateQuota(value: unknown): SettingsDocumentV3["github"]["rest"] {
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
  schedules: SettingsDocumentScheduleOverrides,
): SettingsDocumentV3["knowledgeBackup"] {
  return {
    autoCommit: readBoolean(value.autoCommit, defaults?.autoCommit ?? DEFAULTS.knowledgeBackup.autoCommit),
    autoPush: readBoolean(value.autoPush, defaults?.autoPush ?? DEFAULTS.knowledgeBackup.autoPush),
    remote: readString(value.remote, defaults?.remote ?? DEFAULTS.knowledgeBackup.remote),
    sourceRef: readString(
      value.sourceRef,
      readString(value.branch, defaults?.sourceRef ?? DEFAULTS.knowledgeBackup.sourceRef),
    ),
    remoteBranch: readString(value.remoteBranch, defaults?.remoteBranch ?? DEFAULTS.knowledgeBackup.remoteBranch),
    checkpointCron: resolveCron(
      schedules.knowledgeCheckpointCron,
      readNullablePositiveInteger(value.checkpointIntervalMinutes,
        readNullablePositiveInteger(value.intervalMinutes, null)),
      defaults?.checkpointCron ?? DEFAULTS.knowledgeBackup.checkpointCron,
    ),
    pushCron: resolveCron(
      schedules.knowledgePushCron,
      readNullablePositiveInteger(value.pushIntervalMinutes, null),
      defaults?.pushCron ?? DEFAULTS.knowledgeBackup.pushCron,
    ),
  };
}

function migrateCodeBackup(
  value: Record<string, unknown>,
  defaults: SettingsDocumentDefaults["codeBackup"],
  schedules: SettingsDocumentScheduleOverrides,
): SettingsDocumentV3["codeBackup"] {
  return {
    automaticCheckpoint: readBoolean(value.automaticCheckpoint, defaults?.automaticCheckpoint ?? DEFAULTS.codeBackup.automaticCheckpoint),
    checkpointCron: resolveCron(
      schedules.codeCheckpointCron,
      readNullablePositiveInteger(value.checkpointIntervalMinutes, null),
      defaults?.checkpointCron ?? DEFAULTS.codeBackup.checkpointCron,
    ),
    automaticPush: readBoolean(value.automaticPush, defaults?.automaticPush ?? DEFAULTS.codeBackup.automaticPush),
    pushCron: resolveCron(
      schedules.codePushCron,
      readNullablePositiveInteger(value.pushIntervalMinutes, null),
      defaults?.pushCron ?? DEFAULTS.codeBackup.pushCron,
    ),
    sourceRef: readString(value.sourceRef, defaults?.sourceRef ?? DEFAULTS.codeBackup.sourceRef),
    remote: readString(value.remote, defaults?.remote ?? DEFAULTS.codeBackup.remote),
    remoteBranch: readString(value.remoteBranch, defaults?.remoteBranch ?? DEFAULTS.codeBackup.remoteBranch),
  };
}

function migrateAgentArchive(
  value: Record<string, unknown>,
  defaults: SettingsDocumentDefaults["agentArchive"],
  schedules: SettingsDocumentScheduleOverrides,
): SettingsDocumentV3["agentArchive"] {
  return {
    archiveRepositoryPath: readString(
      value.archiveRepositoryPath,
      defaults?.archiveRepositoryPath ?? DEFAULTS.agentArchive.archiveRepositoryPath,
    ),
    enabled: readBoolean(value.enabled, defaults?.enabled ?? DEFAULTS.agentArchive.enabled),
    exportCron: resolveCron(
      schedules.agentArchiveExportCron,
      readNullablePositiveInteger(value.exportIntervalMinutes, null),
      defaults?.exportCron ?? DEFAULTS.agentArchive.exportCron,
    ),
    automaticPush: readBoolean(value.automaticPush, defaults?.automaticPush ?? DEFAULTS.agentArchive.automaticPush),
    pushCron: resolveCron(
      schedules.agentArchivePushCron,
      readNullablePositiveInteger(value.pushIntervalMinutes, null),
      defaults?.pushCron ?? DEFAULTS.agentArchive.pushCron,
    ),
    sourceRef: readString(value.sourceRef, defaults?.sourceRef ?? DEFAULTS.agentArchive.sourceRef),
    remote: readString(value.remote, defaults?.remote ?? DEFAULTS.agentArchive.remote),
    remoteBranch: readString(value.remoteBranch, defaults?.remoteBranch ?? DEFAULTS.agentArchive.remoteBranch),
  };
}

function resolveCron(
  persisted: string | undefined,
  legacyMinutes: number | null,
  fallback: string,
): string {
  if (typeof persisted === "string" && persisted.trim().length > 0) {
    return persisted.trim();
  }
  if (legacyMinutes !== null) return legacyIntervalToCron(legacyMinutes);
  return fallback;
}

/** Validate all V3 cron policy values after the schema shape is established. */
export function validateSettingsDocumentCrons(
  document: SettingsDocumentV3,
): SettingsDocumentV3 {
  const values = [
    ...Object.entries(document.repositories).map(([id, value]) => [
      `repositories.${id}.syncCron`,
      value.syncCron,
    ] as const),
    ["knowledgeBackup.checkpointCron", document.knowledgeBackup.checkpointCron],
    ["knowledgeBackup.pushCron", document.knowledgeBackup.pushCron],
    ["codeBackup.checkpointCron", document.codeBackup.checkpointCron],
    ["codeBackup.pushCron", document.codeBackup.pushCron],
    ["agentArchive.exportCron", document.agentArchive.exportCron],
    ["agentArchive.pushCron", document.agentArchive.pushCron],
  ] as const;
  for (const [path, expression] of values) {
    try {
      validateCron(expression);
    } catch (error) {
      throw new Error(
        `Invalid settings cron at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return document;
}

/** Validate every user-configurable cadence in the canonical V4 document. */
export function validateSettingsDocumentV4Crons(
  document: SettingsDocumentV4,
): SettingsDocumentV4 {
  const values = [
    ...Object.entries(document.repositories).map(([id, value]) => [
      `repositories.${id}.syncCron`,
      value.syncCron,
    ] as const),
    ["personalDataBackup.checkpointCron", document.personalDataBackup.checkpointCron],
    ["personalDataBackup.pushCron", document.personalDataBackup.pushCron],
    ["codeBackup.checkpointCron", document.codeBackup.checkpointCron],
    ["codeBackup.pushCron", document.codeBackup.pushCron],
    ["agentArchive.exportCron", document.agentArchive.exportCron],
    ["agentArchive.pushCron", document.agentArchive.pushCron],
  ] as const;
  for (const [path, expression] of values) {
    try {
      validateCron(expression);
    } catch (error) {
      throw new Error(
        `Invalid settings cron at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return document;
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

function isCredentialSource(value: unknown): value is SettingsDocumentV3["github"]["verifiedSource"] {
  return value === "settings" ||
    value === "GH_TOKEN" ||
    value === "GITHUB_TOKEN" ||
    value === "gh" ||
    value === "none";
}
