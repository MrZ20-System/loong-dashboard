import { existsSync, readFileSync } from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

const repositorySchema = z
  .object({
    key: z.string().trim().min(1),
    name: z.string().trim().min(1),
    github: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
    path: z.string().trim().min(1),
    remote: z.string().trim().min(1),
    defaultBranch: z.string().trim().min(1),
    worktreeSlots: z.number().int().nonnegative(),
  })
  .strict();

const baseSystemConfigSchema = z
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
        // Knowledge-only Git checkpoint entry (plan 15.6); source
        // repositories never get an entry and default to off.
        checkpoint: z
          .object({
            autoCommit: z.boolean().optional().default(false),
            autoPush: z.boolean().optional().default(false),
            remote: z.string().trim().min(1).optional().default("origin"),
            branch: z.string().trim().min(1).optional().default("main"),
          })
          .optional(),
      })
      .strict(),
    runtime: z
      .object({
        statePath: z.string().trim().min(1),
        worktreesPath: z.string().trim().min(1),
        serverHost: z.string().trim().min(1),
        serverPort: z.number().int().min(1).max(65_535),
      })
      .strict(),
    agent: z
      .object({
        defaultProvider: z.string().trim().min(1),
        defaultModel: z.string().trim().min(1),
        defaultReasoningEffort: z.string().trim().min(1),
        idleProcessMinutes: z.number().int().positive(),
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
      const previousKey = keys.get(repository.key);
      if (previousKey !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["repositories", index, "key"],
          message: `Duplicate repository key; already used at index ${previousKey}`,
        });
      } else {
        keys.set(repository.key, index);
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
    },
  };
}

export function loadSystemConfig(configPath: string): SystemConfig {
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

  return parseSystemConfig(input, absoluteConfigPath);
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
