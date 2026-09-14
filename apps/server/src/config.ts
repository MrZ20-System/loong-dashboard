import { copyFileSync, existsSync, lstatSync, readFileSync } from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

import { atomicWrite } from "@loongboard/knowledge";
import { isGitRepository } from "@loongboard/git-workspace";
import { validateCron } from "@loongboard/scheduler";

import { legacyIntervalToCron } from "./legacy-schedule-migration.js";

const repositorySchema = z
  .object({
    key: z.string().trim().min(1),
    name: z.string().trim().min(1),
    github: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
    path: z.string().trim().min(1),
    remote: z.string().trim().min(1),
    defaultBranch: z.string().trim().min(1),
    worktreeSlots: z.number().int().min(1).max(16),
  })
  .strict();

const legacyCheckpointSchema = z
  .object({
    autoCommit: z.boolean().optional().default(false),
    autoPush: z.boolean().optional().default(false),
    remote: z.string().trim().min(1).optional().default("origin"),
    sourceRef: z.string().trim().min(1).optional(),
    remoteBranch: z.string().trim().min(1).optional().default("loongboard-knowledge-backup"),
    checkpointIntervalMinutes: z.number().int().positive().nullable().optional(),
    pushIntervalMinutes: z.number().int().positive().nullable().optional(),
  })
  .strict();

const baseSystemConfigV1Schema = z
  .object({
    version: z.literal(1),
    timezone: z.string().trim().min(1),
    repositories: z.array(repositorySchema),
    knowledge: z
      .object({
        path: z.string().trim().min(1),
        inbox: z
          .string()
          .trim()
          .min(1)
          .refine((path) => !isAbsolute(path), {
            message: "knowledge.inbox must be relative to knowledge.path",
          }),
        historyLimit: z.number().int().positive(),
        // This checkpoint applies only to the Knowledge repository; source
        // repositories never get an entry and default to off.
        checkpoint: legacyCheckpointSchema.optional(),
      })
      .strict(),
    runtime: z
      .object({
        statePath: z.string().trim().min(1),
        worktreesPath: z.string().trim().min(1),
        /** Managed root for repositories added from Settings. */
        repositoriesPath: z.string().trim().min(1).optional().default("./repositories"),
        serverHost: z.string().trim().min(1),
        serverPort: z.number().int().min(1).max(65_535),
      })
      .strict(),
    agent: z
      .object({
        defaultProvider: z.string().trim().min(1),
        defaultModel: z.string().trim().min(1),
        defaultReasoningEffort: z.string().trim().min(1),
        // Zero retains an idle runtime until explicit stop or server shutdown.
        idleProcessMinutes: z.number().int().nonnegative().default(120),
      })
      .strict(),
  })
  .strict();

const checkpointCronSchema = z.string().trim().min(1);

const baseSystemConfigV2Schema = z
  .object({
    version: z.literal(2),
    timezone: z.string().trim().min(1),
    repositories: z.array(repositorySchema),
    knowledge: z
      .object({
        path: z.string().trim().min(1),
        inbox: z
          .string()
          .trim()
          .min(1)
          .refine((path) => !isAbsolute(path), {
            message: "knowledge.inbox must be relative to knowledge.path",
          }),
        historyLimit: z.number().int().positive(),
        // This checkpoint applies only to the Knowledge repository; source
        // repositories never get an entry and default to off.
        checkpoint: z
          .object({
            autoCommit: z.boolean().optional().default(false),
            autoPush: z.boolean().optional().default(false),
            remote: z.string().trim().min(1).optional().default("origin"),
            sourceRef: z.string().trim().min(1).optional().default("main"),
            remoteBranch: z.string().trim().min(1).optional().default("loongboard-knowledge-backup"),
            checkpointCron: checkpointCronSchema.optional().default("0 0 * * *"),
            pushCron: checkpointCronSchema.optional().default("0 0 * * *"),
          })
          .strict()
          .optional(),
      })
      .strict(),
    runtime: z
      .object({
        statePath: z.string().trim().min(1),
        worktreesPath: z.string().trim().min(1),
        /** Managed root for repositories added from Settings. */
        repositoriesPath: z.string().trim().min(1).optional().default("./repositories"),
        serverHost: z.string().trim().min(1),
        serverPort: z.number().int().min(1).max(65_535),
      })
      .strict(),
    agent: z
      .object({
        defaultProvider: z.string().trim().min(1),
        defaultModel: z.string().trim().min(1),
        defaultReasoningEffort: z.string().trim().min(1),
        // Zero retains an idle runtime until explicit stop or server shutdown.
        idleProcessMinutes: z.number().int().nonnegative().default(120),
      })
      .strict(),
  })
  .strict();

const personalDataSchema = z
  .object({
    /** Git repository root containing knowledge/, prompts/, and skills/. */
    path: z.string().trim().min(1),
  })
  .strict();

const baseSystemConfigSchema = z
  .object({
    version: z.literal(3),
    timezone: z.string().trim().min(1),
    repositories: z.array(repositorySchema),
    personalData: personalDataSchema,
    knowledge: z
      .object({
        path: z.string().trim().min(1),
        inbox: z
          .string()
          .trim()
          .min(1)
          .refine((path) => !isAbsolute(path), {
            message: "knowledge.inbox must be relative to knowledge.path",
          }),
        historyLimit: z.number().int().positive(),
        checkpoint: z
          .object({
            autoCommit: z.boolean().optional().default(false),
            autoPush: z.boolean().optional().default(false),
            remote: z.string().trim().min(1).optional().default("origin"),
            sourceRef: z.string().trim().min(1).optional().default("main"),
            remoteBranch: z.string().trim().min(1).optional().default("loongboard-knowledge-backup"),
            checkpointCron: checkpointCronSchema.optional().default("0 0 * * *"),
            pushCron: checkpointCronSchema.optional().default("0 0 * * *"),
          })
          .strict()
          .optional(),
      })
      .strict(),
    runtime: z
      .object({
        statePath: z.string().trim().min(1),
        worktreesPath: z.string().trim().min(1),
        /** Managed root for repositories added from Settings. */
        repositoriesPath: z.string().trim().min(1).optional().default("./repositories"),
        serverHost: z.string().trim().min(1),
        serverPort: z.number().int().min(1).max(65_535),
      })
      .strict(),
    agent: z
      .object({
        defaultProvider: z.string().trim().min(1),
        defaultModel: z.string().trim().min(1),
        defaultReasoningEffort: z.string().trim().min(1),
        idleProcessMinutes: z.number().int().nonnegative().default(120),
      })
      .strict(),
  })
  .strict();

function isValidIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate the complete system boundary before any typed runtime code sees
 * it. Repository keys and GitHub slugs are durable identities, so duplicate
 * values are rejected here rather than relying on a later SQLite constraint.
 */
export const systemConfigSchema = baseSystemConfigSchema.superRefine(
  (config, context) => {
    if (!isValidIanaTimeZone(config.timezone)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["timezone"],
        message: "Expected a valid IANA timezone",
      });
    }

    const keys = new Map<string, number>();
    const githubRepositories = new Map<string, number>();
    config.repositories.forEach((repository, index) => {
      const normalizedKey = repository.key.toLocaleLowerCase("en-US");
      const previousKey = keys.get(normalizedKey);
      if (previousKey !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["repositories", index, "key"],
          message: `Duplicate repository key; already used at index ${previousKey}`,
        });
      } else {
        keys.set(normalizedKey, index);
      }

      // GitHub repository names are case-insensitive for identity purposes.
      const githubKey = repository.github.toLocaleLowerCase("en-US");
      const previousGithub = githubRepositories.get(githubKey);
      if (previousGithub !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["repositories", index, "github"],
          message: `Duplicate GitHub repository; already used at index ${previousGithub}`,
        });
      } else {
        githubRepositories.set(githubKey, index);
      }
    });

    const checkpoint = config.knowledge.checkpoint;
    if (checkpoint !== undefined) {
      for (const field of ["checkpointCron", "pushCron"] as const) {
        try {
          validateCron(checkpoint[field]);
        } catch (error) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["knowledge", "checkpoint", field],
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  },
);

export type SystemConfig = z.infer<typeof systemConfigSchema>;

function resolveConfiguredPath(configDirectory: string, path: string): string {
  return isAbsolute(path) ? normalize(path) : resolve(configDirectory, path);
}

function resolveKnowledgeInbox(
  knowledgePath: string,
  inbox: string,
  configPath: string,
): string {
  const inboxPath = resolve(knowledgePath, inbox);
  const relativeInboxPath = relative(knowledgePath, inboxPath);
  if (
    relativeInboxPath.length === 0 ||
    relativeInboxPath === ".." ||
    relativeInboxPath.startsWith(`..${sep}`) ||
    isAbsolute(relativeInboxPath)
  ) {
    throw new Error(
      `Invalid system configuration at ${configPath}: knowledge.inbox must stay inside knowledge.path`,
    );
  }

  return inboxPath;
}

function isStrictDescendant(parent: string, child: string): boolean {
  const relativePath = relative(resolve(parent), resolve(child));
  return (
    relativePath.length > 0 &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

function assertLegacyPersonalDataLayout(
  legacyRoot: string,
  configPath: string,
): void {
  const requiredDirectories = ["knowledge", "prompts", "skills"];
  if (!isGitRepository(legacyRoot)) {
    throw new Error(
      `System configuration migration requires manual Personal Data migration at ${configPath}: ` +
        `legacy knowledge.path must be a Git repository (${legacyRoot})`,
    );
  }
  const missing = requiredDirectories.filter((directory) => {
    const path = join(legacyRoot, directory);
    try {
      return !existsSync(path) || !lstatSync(path).isDirectory();
    } catch {
      return true;
    }
  });
  if (missing.length > 0) {
    throw new Error(
      `System configuration migration requires manual Personal Data migration at ${configPath}: ` +
        `Git repository ${legacyRoot} must contain directories ${requiredDirectories
          .map((directory) => `${directory}/`)
          .join(", ")}; missing ${missing.map((directory) => `${directory}/`).join(", ")}`,
    );
  }
}

function canonicalizeLegacySystemConfig(
  source: z.infer<typeof baseSystemConfigV1Schema> | z.infer<typeof baseSystemConfigV2Schema>,
): Record<string, unknown> {
  const checkpoint = source.knowledge.checkpoint;
  const canonicalCheckpoint = checkpoint === undefined
    ? undefined
    : "checkpointIntervalMinutes" in checkpoint
      ? {
          autoCommit: checkpoint.autoCommit,
          autoPush: checkpoint.autoPush,
          remote: checkpoint.remote,
          sourceRef: checkpoint.sourceRef ?? "main",
          remoteBranch: checkpoint.remoteBranch,
          checkpointCron: legacyIntervalToCronOrDefault(checkpoint.checkpointIntervalMinutes),
          pushCron: legacyIntervalToCronOrDefault(checkpoint.pushIntervalMinutes),
        }
      : {
          autoCommit: checkpoint.autoCommit,
          autoPush: checkpoint.autoPush,
          remote: checkpoint.remote,
          sourceRef: checkpoint.sourceRef,
          remoteBranch: checkpoint.remoteBranch,
          checkpointCron: (checkpoint as { checkpointCron: string }).checkpointCron,
          pushCron: (checkpoint as { pushCron: string }).pushCron,
        };
  return {
    ...source,
    version: 3,
    personalData: { path: source.knowledge.path },
    knowledge: {
      ...source.knowledge,
      path: join(source.knowledge.path, "knowledge"),
      ...(canonicalCheckpoint === undefined ? {} : { checkpoint: canonicalCheckpoint }),
    },
  };
}

/** Convert a legacy V1 system.yaml object directly into canonical V3. */
export function migrateSystemConfigV1ToV3(
  raw: unknown,
  configPath?: string,
): unknown {
  const source = baseSystemConfigV1Schema.parse(raw);
  const migrated = canonicalizeLegacySystemConfig(source);
  if (configPath !== undefined) {
    parseSystemConfig(migrated, configPath);
    assertLegacyPersonalDataLayout(
      resolveConfiguredPath(dirname(resolve(configPath)), source.knowledge.path),
      configPath,
    );
  }
  return migrated;
}

/** Convert a legacy V2 system.yaml object directly into canonical V3. */
export function migrateSystemConfigV2ToV3(
  raw: unknown,
  configPath?: string,
): unknown {
  const source = baseSystemConfigV2Schema.parse(raw);
  const migrated = canonicalizeLegacySystemConfig(source);
  if (configPath !== undefined) {
    parseSystemConfig(migrated, configPath);
    assertLegacyPersonalDataLayout(
      resolveConfiguredPath(dirname(resolve(configPath)), source.knowledge.path),
      configPath,
    );
  }
  return migrated;
}

/** Migration-only compatibility helper for callers from the V1/V2 release. */
export function migrateSystemConfigV1ToV2(raw: unknown): unknown {
  const source = baseSystemConfigV1Schema.parse(raw);
  const legacy = source.knowledge.checkpoint;
  if (legacy === undefined) return { ...source, version: 2 };
  return {
    ...source,
    version: 2,
    knowledge: {
      ...source.knowledge,
      checkpoint: {
        autoCommit: legacy.autoCommit,
        autoPush: legacy.autoPush,
        remote: legacy.remote,
        sourceRef: legacy.sourceRef ?? "main",
        remoteBranch: legacy.remoteBranch,
        checkpointCron: legacyIntervalToCronOrDefault(legacy.checkpointIntervalMinutes),
        pushCron: legacyIntervalToCronOrDefault(legacy.pushIntervalMinutes),
      },
    },
  };
}

function legacyIntervalToCronOrDefault(value: number | null | undefined): string {
  return value === null || value === undefined
    ? "0 0 * * *"
    : legacyIntervalToCron(value);
}

/** Persist a validated legacy migration with a recoverable source backup. */
function persistSystemConfigMigration(
  configPath: string,
  migrated: unknown,
  sourceVersion: 1 | 2,
): void {
  const absolutePath = resolve(configPath);
  const stat = lstatSync(absolutePath);
  if (!stat.isFile()) {
    throw new Error(`System configuration is not a regular file: ${absolutePath}`);
  }
  const backupPath = `${absolutePath}.v${sourceVersion}.bak`;
  copyFileSync(absolutePath, backupPath);
  atomicWrite(absolutePath, stringifyYaml(migrated, { indent: 2 }));
}

export function parseSystemConfig(
  input: unknown,
  configPath: string,
): SystemConfig {
  const parsed = systemConfigSchema.safeParse(input);

  if (!parsed.success) {
    throw new Error(
      `Invalid system configuration at ${configPath}: ${parsed.error.message}`,
    );
  }

  const configDirectory = dirname(resolve(configPath));
  const personalDataPath = resolveConfiguredPath(
    configDirectory,
    parsed.data.personalData.path,
  );
  const knowledgePath = resolveConfiguredPath(
    configDirectory,
    parsed.data.knowledge.path,
  );
  if (!isStrictDescendant(personalDataPath, knowledgePath)) {
    throw new Error(
      `Invalid system configuration at ${configPath}: knowledge.path must be a strict descendant of personalData.path`,
    );
  }

  return {
    ...parsed.data,
    personalData: {
      ...parsed.data.personalData,
      path: personalDataPath,
    },
    repositories: parsed.data.repositories.map((repository) => ({
      ...repository,
      path: resolveConfiguredPath(configDirectory, repository.path),
    })),
    knowledge: {
      ...parsed.data.knowledge,
      path: knowledgePath,
      inbox: resolveKnowledgeInbox(
        knowledgePath,
        parsed.data.knowledge.inbox,
        configPath,
      ),
    },
    runtime: {
      ...parsed.data.runtime,
      statePath: resolveConfiguredPath(
        configDirectory,
        parsed.data.runtime.statePath,
      ),
      worktreesPath: resolveConfiguredPath(
        configDirectory,
        parsed.data.runtime.worktreesPath,
      ),
      repositoriesPath: resolveConfiguredPath(
        configDirectory,
        parsed.data.runtime.repositoriesPath,
      ),
    },
  };
}

export function loadSystemConfig(
  configPath: string,
  environment?: NodeJS.ProcessEnv,
): SystemConfig {
  const absoluteConfigPath = resolve(configPath);

  let input: unknown;
  try {
    input = parseYaml(readFileSync(absoluteConfigPath, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to read system configuration at ${absoluteConfigPath}: ${reason}`,
    );
  }

  const version = isRecord(input) ? input.version : undefined;
  const migratedInput = version === 1
    ? migrateSystemConfigV1ToV3(input, absoluteConfigPath)
    : version === 2
      ? migrateSystemConfigV2ToV3(input, absoluteConfigPath)
      : input;
  const config = parseSystemConfig(migratedInput, absoluteConfigPath);
  if (version === 1 || version === 2) {
    persistSystemConfigMigration(absoluteConfigPath, migratedInput, version);
  }
  return environment === undefined
    ? config
    : applyRuntimeEnvironmentOverrides(config, environment);
}

/** Apply process-level runtime overrides without changing config-relative paths. */
export function applyRuntimeEnvironmentOverrides(
  config: SystemConfig,
  environment: NodeJS.ProcessEnv,
): SystemConfig {
  const host = readEnvironmentString(environment.LOONGBOARD_SERVER_HOST);
  const port = readEnvironmentPort(environment.LOONGBOARD_SERVER_PORT);
  return {
    ...config,
    runtime: {
      ...config.runtime,
      ...(host === undefined ? {} : { serverHost: host }),
      ...(port === undefined ? {} : { serverPort: port }),
    },
  };
}

function readEnvironmentString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error("LOONGBOARD_SERVER_HOST must not be empty");
  }
  return trimmed;
}

function readEnvironmentPort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  const port = Number(trimmed);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("LOONGBOARD_SERVER_PORT must be an integer between 1 and 65535");
  }
  return port;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function resolveSystemConfigPath(
  environment: NodeJS.ProcessEnv,
  currentWorkingDirectory: string,
): string {
  let repositoryRoot = resolve(currentWorkingDirectory);
  while (!existsSync(join(repositoryRoot, "pnpm-workspace.yaml"))) {
    const parentDirectory = dirname(repositoryRoot);
    if (parentDirectory === repositoryRoot) {
      throw new Error(
        `Unable to locate LoongBoard repository root from ${currentWorkingDirectory}`,
      );
    }
    repositoryRoot = parentDirectory;
  }

  const configuredPath = environment.LOONGBOARD_SYSTEM_CONFIG;
  if (configuredPath !== undefined) {
    if (configuredPath.trim().length === 0) {
      throw new Error("LOONGBOARD_SYSTEM_CONFIG must not be empty");
    }
    return resolve(repositoryRoot, configuredPath);
  }

  return resolve(repositoryRoot, "..", "system.yaml");
}
