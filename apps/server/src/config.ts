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

const baseSystemConfigSchema = z
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

/** Convert a V1 system.yaml object into the complete V2 shape. */
export function migrateSystemConfigV1ToV2(raw: unknown): unknown {
  const source = baseSystemConfigV1Schema.parse(raw);
  const legacy = source.knowledge.checkpoint;
  if (legacy === undefined) {
    return { ...source, version: 2 };
  }
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
        checkpointCron: legacyIntervalToCronOrDefault(
          legacy.checkpointIntervalMinutes,
        ),
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

/** Persist a validated V1->V2 migration with a recoverable source backup. */
function persistSystemConfigMigration(
  configPath: string,
  migrated: unknown,
): void {
  const absolutePath = resolve(configPath);
  const stat = lstatSync(absolutePath);
  if (!stat.isFile()) {
    throw new Error(`System configuration is not a regular file: ${absolutePath}`);
  }
  const backupPath = `${absolutePath}.v1.bak`;
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
  const knowledgePath = resolveConfiguredPath(
    configDirectory,
    parsed.data.knowledge.path,
  );

  return {
    ...parsed.data,
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
    ? migrateSystemConfigV1ToV2(input)
    : input;
  const config = parseSystemConfig(migratedInput, absoluteConfigPath);
  if (version === 1) persistSystemConfigMigration(absoluteConfigPath, migratedInput);
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
