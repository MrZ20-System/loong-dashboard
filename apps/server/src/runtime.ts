import { mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  openDatabase,
  reconcileRepositories,
  type DatabaseClient,
} from "@loongboard/database";
import {
  GhGitHubMetadataProvider,
  type GhGitHubMetadataProviderOptions,
  type GitHubMetadataProvider,
} from "@loongboard/github";
import type { FastifyInstance, FastifyServerOptions } from "fastify";

import { buildApp } from "./app.js";
import {
  loadSystemConfig,
  resolveSystemConfigPath,
  type SystemConfig,
} from "./config.js";
import {
  RepositorySyncCoordinator,
  type SyncCoordinatorLogger,
} from "./sync-coordinator.js";

export interface CreateServerRuntimeOptions {
  /** Use a prevalidated config in tests or an embedding process. */
  config?: SystemConfig;
  configPath?: string;
  environment?: NodeJS.ProcessEnv;
  currentWorkingDirectory?: string;
  provider?: GitHubMetadataProvider;
  providerOptions?: GhGitHubMetadataProviderOptions;
  now?: () => Date;
  coordinatorLogger?: SyncCoordinatorLogger;
  appOptions?: FastifyServerOptions;
}

export interface ServerRuntime {
  readonly app: FastifyInstance;
  readonly config: SystemConfig;
  readonly database: DatabaseClient;
  readonly databasePath: string;
  readonly coordinator: RepositorySyncCoordinator;
}

/** Resolve the one SQLite path owned by the Server runtime. */
export function runtimeDatabasePath(config: SystemConfig): string {
  return join(config.runtime.statePath, "loongboard.sqlite3");
}

/**
 * Compose the complete Stage 1 process without listening on a socket.
 * Configuration is loaded first, then the runtime directory/database is
 * prepared, and only then are typed application dependencies constructed.
 */
export function createServerRuntime(
  options: CreateServerRuntimeOptions = {},
): ServerRuntime {
  const config = loadRuntimeConfig(options);
  mkdirSync(config.runtime.statePath, { recursive: true });
  const databasePath = runtimeDatabasePath(config);
  const database = openDatabase(databasePath);

  try {
    reconcileRepositories(database, config.repositories);

    const provider =
      options.provider ?? new GhGitHubMetadataProvider(options.providerOptions);
    const coordinator = new RepositorySyncCoordinator({
      database,
      provider,
      now: options.now,
      logger: options.coordinatorLogger,
    });
    const app = buildApp(
      {
        database,
        timezone: config.timezone,
        syncCoordinator: coordinator,
      },
      options.appOptions,
    );

    let closePromise: Promise<void> | undefined;
    app.addHook("onClose", async () => {
      closePromise ??= (async () => {
        await coordinator.close();
        database.close();
      })();
      await closePromise;
    });

    return { app, config, database, databasePath, coordinator };
  } catch (error) {
    database.close();
    throw error;
  }
}

function loadRuntimeConfig(options: CreateServerRuntimeOptions): SystemConfig {
  if (options.config !== undefined) return options.config;
  const environment = options.environment ?? process.env;
  const currentWorkingDirectory =
    options.currentWorkingDirectory ?? process.cwd();
  const configPath =
    options.configPath ??
    resolveSystemConfigPath(environment, currentWorkingDirectory);
  return loadSystemConfig(configPath);
}
