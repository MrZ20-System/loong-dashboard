import { mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  openDatabase,
  reconcileRepositories,
  recoverInterruptedAgentSessions,
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
import { PullRequestEnrichmentService } from "./enrichment-service.js";
import { DomainReclassificationService } from "./reclassification-service.js";
import {
  type AgentRuntime,
  type AgentSessionSpec,
} from "@loongboard/agent-runtime";

import { AgentChatController } from "./agent-chat.js";
import { KnowledgeController } from "./knowledge.js";
import { SchedulerEngine } from "./scheduler.js";
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
  /** Override the DSH-backed runtime factory (tests inject a scripted one). */
  runtimeFactory?: (spec: AgentSessionSpec) => AgentRuntime;
}

export interface ServerRuntime {
  readonly app: FastifyInstance;
  readonly config: SystemConfig;
  readonly database: DatabaseClient;
  readonly databasePath: string;
  readonly coordinator: RepositorySyncCoordinator;
  readonly reclassification: DomainReclassificationService;
  readonly agentChat: AgentChatController;
  readonly knowledge: KnowledgeController;
  readonly scheduler: SchedulerEngine;
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
    // Startup recovery: mark sessions a previous process left running as
    // interrupted so their worktree slots are recyclable and knowledge
    // agent-version aggregation is not held open forever (plan 12.2/16.2).
    recoverInterruptedAgentSessions(database);

    const provider =
      options.provider ?? new GhGitHubMetadataProvider(options.providerOptions);
    const enricher = new PullRequestEnrichmentService({
      database,
      provider,
      logger: options.coordinatorLogger,
    });
    const coordinator = new RepositorySyncCoordinator({
      database,
      provider,
      now: options.now,
      logger: options.coordinatorLogger,
      enricher,
    });
    const reclassification = new DomainReclassificationService({ database });
    const agentChat = new AgentChatController({
      database,
      agentSessionsPath: join(config.runtime.statePath, "agent-sessions"),
      worktreesPath: config.runtime.worktreesPath,
      knowledgePath: config.knowledge.path,
      defaults: {
        provider: config.agent.defaultProvider,
        model: config.agent.defaultModel,
        reasoningEffort: config.agent.defaultReasoningEffort,
        idleProcessMinutes: config.agent.idleProcessMinutes,
      },
      ...(options.runtimeFactory !== undefined
        ? { runtimeFactory: options.runtimeFactory as (spec: AgentSessionSpec) => AgentRuntime }
        : {}),
    });
    const knowledge = new KnowledgeController({
      database,
      knowledgePath: config.knowledge.path,
      historyLimit: config.knowledge.historyLimit,
      chats: agentChat,
    });
    knowledge.start();
    const scheduler = new SchedulerEngine({
      database,
      chats: agentChat,
      agentSessionsPath: join(config.runtime.statePath, "agent-sessions"),
    });
    scheduler.start();
    const app = buildApp(
      {
        database,
        timezone: config.timezone,
        syncCoordinator: coordinator,
        reclassification,
        agentChat,
        knowledge,
        scheduledTasks: {
          engine: scheduler,
          defaults: {
            provider: config.agent.defaultProvider,
            model: config.agent.defaultModel,
            reasoningEffort: config.agent.defaultReasoningEffort,
          },
        },
      },
      options.appOptions,
    );

    let closePromise: Promise<void> | undefined;
    app.addHook("onClose", async () => {
      closePromise ??= (async () => {
        await coordinator.close();
        await reclassification.close();
        await agentChat.close();
        await knowledge.close();
        await scheduler.close();
        database.close();
      })();
      await closePromise;
    });

    return {
      app,
      config,
      database,
      databasePath,
      coordinator,
      reclassification,
      agentChat,
      knowledge,
      scheduler,
    };
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
