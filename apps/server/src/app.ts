import {
  apiErrorSchema,
  healthResponseSchema,
  type ApiErrorCode,
  type HealthResponse,
} from "@loongboard/contracts";
import {
  LocalGitWorkspace,
  type GitWorkspace,
} from "@loongboard/git-workspace";
import type { DatabaseClient } from "@loongboard/database";
import type { GitHubMetadataProvider } from "@loongboard/github";
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";

import { AgentChatController, registerAgentRoutes } from "./agent-chat.js";
import {
  AuthInvalidPasswordError,
  AuthRateLimitedError,
  AuthRequiredError,
  AuthService,
} from "./auth.js";
import type { DomainFileService } from "./domain-file.js";
import { registerDiffRoutes } from "./diff.js";
import { registerDomainRoutes } from "./domains.js";
import type { KnowledgeController } from "./knowledge.js";
import { registerKnowledgeRoutes } from "./knowledge.js";
import type { MetadataMaintenanceService } from "./metadata-maintenance.js";
import { registerMetadataMaintenanceRoutes } from "./metadata-maintenance-routes.js";
import { DomainReclassificationService, type DomainReclassification } from "./reclassification-service.js";
import { registerAuthRoutes, isPublicApiPath } from "./routes/auth.js";
import { registerMetadataRoutes } from "./routes/metadata.js";
import { registerRepositoryRoutes } from "./routes/repositories.js";
import { registerRepositoryOnboardingRoutes } from "./routes/repository-onboarding.js";
import { registerPersonalDataRoutes } from "./routes/personal-data.js";
import { registerSyncRoutes } from "./routes/sync.js";
import {
  InvalidRequestError,
} from "./route-helpers.js";
import { registerScheduledTaskRoutes } from "./scheduled-tasks.js";
import type { SchedulerEngine } from "./scheduler.js";
import {
  registerSettingsRoutes,
  type SettingsController,
} from "./settings.js";
import type { SyncCoordinator } from "./sync-coordinator.js";
import type { RepositoryOnboardingService } from "./repository-onboarding.js";
import type { PersonalDataService } from "./personal-data.js";
import { IssueDetailService } from "./issue-detail-service.js";
import { registerProductionStaticSite } from "./static-site.js";

const healthResponse: HealthResponse = healthResponseSchema.parse({
  status: "ok",
});

/** Complete dependency set owned by the production runtime. */
export interface BuildProductionAppDependencies {
  database: DatabaseClient;
  timezone: string;
  syncCoordinator: SyncCoordinator;
  github: GitHubMetadataProvider;
  reclassification: DomainReclassification;
  gitWorkspace: GitWorkspace;
  agentChat: AgentChatController;
  knowledge: KnowledgeController;
  scheduledTasks: {
    engine: SchedulerEngine;
    defaults: { provider: string; model: string; reasoningEffort: string };
  };
  domainFiles: DomainFileService;
  settings: SettingsController;
  auth: AuthService;
  metadataMaintenance: MetadataMaintenanceService;
  repositoryOnboarding: RepositoryOnboardingService;
  personalData: PersonalDataService;
}

/** Lightweight dependency set intentionally limited to focused route tests. */
export interface BuildTestAppDependencies {
  database: DatabaseClient;
  timezone: string;
  syncCoordinator: SyncCoordinator;
  github?: GitHubMetadataProvider;
  reclassification?: DomainReclassification;
  gitWorkspace?: GitWorkspace;
  agentChat?: AgentChatController;
  knowledge?: KnowledgeController;
  scheduledTasks?: {
    engine: SchedulerEngine;
    defaults: { provider: string; model: string; reasoningEffort: string };
  };
  domainFiles?: DomainFileService;
  settings?: SettingsController;
  auth?: AuthService;
  metadataMaintenance?: MetadataMaintenanceService;
  repositoryOnboarding?: RepositoryOnboardingService;
  personalData?: PersonalDataService;
}

/** Fastify options shared by production and focused test app builders. */
export interface BuildProductionAppOptions extends FastifyServerOptions {
  /** Absolute or cwd-relative React production artifact root. */
  staticRoot?: string;
}

export type BuildTestAppOptions = BuildProductionAppOptions;

/**
 * Build the complete production application. Every product capability is
 * present in this composition and is supplied by the runtime explicitly.
 */
export function buildProductionApp(
  dependencies: BuildProductionAppDependencies,
  options: BuildProductionAppOptions = {},
): FastifyInstance {
  const { staticRoot, ...fastifyOptions } = options;
  const issueDetails = new IssueDetailService({
    database: dependencies.database,
    github: dependencies.github,
  });
  const app = Fastify(fastifyOptions);
  configureAppShell(app, dependencies.auth);
  registerRoutes(app, {
    ...dependencies,
    issueDetails,
  });
  if (staticRoot !== undefined) {
    registerProductionStaticSite(app, staticRoot);
  }
  return app;
}

/**
 * Build a deliberately lightweight app for focused route tests only.
 * Only this builder owns fallback services or omits optional capabilities.
 */
export function buildTestApp(
  dependencies: BuildTestAppDependencies,
  options: BuildTestAppOptions = {},
): FastifyInstance {
  const { staticRoot, ...fastifyOptions } = options;
  const auth = dependencies.auth ?? AuthService.disabled();
  const ownsReclassification = dependencies.reclassification === undefined;
  const reclassification = dependencies.reclassification ??
    new DomainReclassificationService({ database: dependencies.database });
  const gitWorkspace = dependencies.gitWorkspace ?? new LocalGitWorkspace();
  const issueDetails = new IssueDetailService({
    database: dependencies.database,
    ...(dependencies.github === undefined ? {} : { github: dependencies.github }),
  });
  const app = Fastify(fastifyOptions);
  configureAppShell(app, auth);
  registerRoutes(app, {
    ...dependencies,
    reclassification,
    gitWorkspace,
    issueDetails,
  });
  if (staticRoot !== undefined) {
    registerProductionStaticSite(app, staticRoot);
  }
  if (ownsReclassification) {
    app.addHook("onClose", async () => {
      await reclassification.close();
    });
  }
  return app;
}

interface RegisterRoutesDependencies {
  database: DatabaseClient;
  timezone: string;
  syncCoordinator: SyncCoordinator;
  reclassification: DomainReclassification;
  gitWorkspace: GitWorkspace;
  issueDetails: IssueDetailService;
  domainFiles?: DomainFileService;
  agentChat?: AgentChatController;
  knowledge?: KnowledgeController;
  scheduledTasks?: {
    engine: SchedulerEngine;
    defaults: { provider: string; model: string; reasoningEffort: string };
  };
  settings?: SettingsController;
  metadataMaintenance?: MetadataMaintenanceService;
  repositoryOnboarding?: RepositoryOnboardingService;
  personalData?: PersonalDataService;
}

function configureAppShell(app: FastifyInstance, auth: AuthService): void {
  configureJsonParser(app);

  app.get("/api/health", async (_request, reply) => {
    return reply.code(200).send(healthResponse);
  });
  app.get("/api/health/live", async (_request, reply) => {
    return reply.code(200).send(healthResponse);
  });

  registerAuthRoutes(app, auth);
  app.addHook("onRequest", async (request, reply) => {
    const pathname = request.url.split("?", 1)[0];
    if (!pathname.startsWith("/api/") || isPublicApiPath(pathname)) return;
    if (auth.isAuthorized(request.headers.cookie)) return;
    return reply
      .code(401)
      .type("application/json")
      .send({ error: { code: "AUTH_REQUIRED", message: "Authentication required" } });
  });

  app.setErrorHandler((error, _request, reply) => {
    if (reply.sent) return;
    const response = errorResponse(error);
    return reply
      .code(response.statusCode)
      .type("application/json")
      .send(response.body);
  });
}

function registerRoutes(
  app: FastifyInstance,
  dependencies: RegisterRoutesDependencies,
): void {
  registerRepositoryRoutes(app, {
    database: dependencies.database,
    onboarding: dependencies.repositoryOnboarding,
  });
  if (dependencies.repositoryOnboarding !== undefined) {
    registerRepositoryOnboardingRoutes(app, {
      onboarding: dependencies.repositoryOnboarding,
    });
  }
  if (dependencies.personalData !== undefined) {
    registerPersonalDataRoutes(app, {
      personalData: dependencies.personalData,
      // SettingsController owns the combined status + backup policy GET.
      registerStatusRoute: false,
    });
  }
  registerSyncRoutes(app, {
    database: dependencies.database,
    syncCoordinator: dependencies.syncCoordinator,
  });
  registerMetadataRoutes(app, {
    database: dependencies.database,
    calendarTimeZone: dependencies.timezone,
    issueDetails: dependencies.issueDetails,
  });
  registerDomainRoutes(app, {
    database: dependencies.database,
    reclassification: dependencies.reclassification,
    domainFiles: dependencies.domainFiles,
  });
  registerDiffRoutes(app, {
    database: dependencies.database,
    gitWorkspace: dependencies.gitWorkspace,
  });
  if (dependencies.metadataMaintenance !== undefined) {
    registerMetadataMaintenanceRoutes(app, { service: dependencies.metadataMaintenance });
  }
  if (dependencies.agentChat !== undefined) {
    registerAgentRoutes(app, dependencies.agentChat);
  }
  if (dependencies.knowledge !== undefined) {
    registerKnowledgeRoutes(app, dependencies.knowledge);
  }
  if (dependencies.scheduledTasks !== undefined) {
    registerScheduledTaskRoutes(app, {
      database: dependencies.database,
      engine: dependencies.scheduledTasks.engine,
      defaults: dependencies.scheduledTasks.defaults,
    });
  }
  if (dependencies.settings !== undefined) {
    registerSettingsRoutes(app, { controller: dependencies.settings });
  }
}

function configureJsonParser(app: FastifyInstance): void {
  const defaultJsonParser = app.getDefaultJsonParser("error", "ignore");
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (request, payload, done) => {
      if (payload.length === 0) {
        done(null, undefined);
        return;
      }
      defaultJsonParser(request, payload as string, done);
    },
  );
}

function errorResponse(error: unknown): {
  statusCode: number;
  body: unknown;
} {
  const code = errorCode(error);
  const statusCode =
    code === "INVALID_REQUEST"
      ? 400
      : code === "INVALID_CURSOR"
        ? 400
        : code === "REPOSITORY_NOT_FOUND" ||
            code === "DOMAIN_NOT_FOUND" ||
            code === "DOMAIN_VERSION_NOT_FOUND" ||
            code === "PULL_REQUEST_NOT_FOUND" ||
            code === "FILE_NOT_FOUND" ||
            code === "ISSUE_NOT_FOUND" ||
            code === "KNOWLEDGE_DOCUMENT_NOT_FOUND" ||
            code === "KNOWLEDGE_VERSION_NOT_FOUND" ||
            code === "SCHEDULED_TASK_NOT_FOUND" ||
            code === "AGENT_SESSION_NOT_FOUND" ||
            code === "SYNC_RUN_NOT_FOUND" ||
            code === "MAINTENANCE_RUN_NOT_FOUND" ||
            code === "REPOSITORY_ONBOARDING_NOT_FOUND"
          ? 404
          : code === "AUTH_REQUIRED" || code === "AUTH_INVALID_PASSWORD"
            ? 401
            : code === "AUTH_RATE_LIMITED"
              ? 429
              : code === "SYNC_ALREADY_RUNNING" ||
                  code === "HISTORY_PAUSED" ||
                  code === "DOMAIN_NAME_CONFLICT" ||
                  code === "AGENT_TURN_BUSY" ||
                  code === "AGENT_INTERACTION_UNAVAILABLE" ||
                  code === "WORKSPACE_BUSY" ||
                  code === "WORKSPACE_REVISION_MISMATCH" ||
                  code === "KNOWLEDGE_DOCUMENT_CONFLICT" ||
                  code === "WORKTREE_POOL_EXHAUSTED" ||
                  code === "SCHEDULED_TASK_WORKSPACE_BUSY" ||
                  code === "REPOSITORY_ONBOARDING_CONFLICT" ||
                  code === "REPOSITORY_ONBOARDING_FAILED" ||
                  code === "PERSONAL_DATA_IMPORT_CONFLICT" ||
                  code === "PERSONAL_DATA_IMPORT_FAILED" ||
                  code === "PERSONAL_DATA_UNAVAILABLE"
                ? 409
                : 500;
  const message = requestErrorMessage(error, code);
  const body = apiErrorSchema.parse({ error: { code, message } });
  return { statusCode, body };
}

function errorCode(error: unknown): ApiErrorCode {
  if (
    error instanceof InvalidRequestError ||
    isMalformedJsonError(error) ||
    isUnsupportedContentTypeError(error)
  ) {
    return "INVALID_REQUEST";
  }
  if (hasCode(error, "INVALID_CURSOR")) return "INVALID_CURSOR";
  if (hasCode(error, "REPOSITORY_NOT_FOUND")) return "REPOSITORY_NOT_FOUND";
  if (hasCode(error, "REPOSITORY_ONBOARDING_NOT_FOUND")) return "REPOSITORY_ONBOARDING_NOT_FOUND";
  if (hasCode(error, "REPOSITORY_ONBOARDING_CONFLICT")) return "REPOSITORY_ONBOARDING_CONFLICT";
  if (hasCode(error, "REPOSITORY_ONBOARDING_FAILED")) return "REPOSITORY_ONBOARDING_FAILED";
  if (hasCode(error, "PERSONAL_DATA_IMPORT_CONFLICT")) return "PERSONAL_DATA_IMPORT_CONFLICT";
  if (hasCode(error, "PERSONAL_DATA_IMPORT_FAILED")) return "PERSONAL_DATA_IMPORT_FAILED";
  if (hasCode(error, "PERSONAL_DATA_UNAVAILABLE")) return "PERSONAL_DATA_UNAVAILABLE";
  if (hasCode(error, "DOMAIN_NOT_FOUND")) return "DOMAIN_NOT_FOUND";
  if (hasCode(error, "DOMAIN_VERSION_NOT_FOUND")) return "DOMAIN_VERSION_NOT_FOUND";
  if (hasCode(error, "DOMAIN_NAME_CONFLICT")) return "DOMAIN_NAME_CONFLICT";
  if (hasCode(error, "PULL_REQUEST_NOT_FOUND")) return "PULL_REQUEST_NOT_FOUND";
  if (hasCode(error, "FILE_NOT_FOUND")) return "FILE_NOT_FOUND";
  if (hasCode(error, "ISSUE_NOT_FOUND")) return "ISSUE_NOT_FOUND";
  if (hasCode(error, "KNOWLEDGE_DOCUMENT_NOT_FOUND")) return "KNOWLEDGE_DOCUMENT_NOT_FOUND";
  if (hasCode(error, "KNOWLEDGE_DOCUMENT_CONFLICT")) return "KNOWLEDGE_DOCUMENT_CONFLICT";
  if (hasCode(error, "KNOWLEDGE_VERSION_NOT_FOUND")) return "KNOWLEDGE_VERSION_NOT_FOUND";
  if (hasCode(error, "SCHEDULED_TASK_NOT_FOUND")) return "SCHEDULED_TASK_NOT_FOUND";
  if (hasCode(error, "SCHEDULED_TASK_WORKSPACE_BUSY")) return "SCHEDULED_TASK_WORKSPACE_BUSY";
  if (hasCode(error, "AGENT_SESSION_NOT_FOUND")) return "AGENT_SESSION_NOT_FOUND";
  if (hasCode(error, "AGENT_TURN_BUSY")) return "AGENT_TURN_BUSY";
  if (hasCode(error, "AGENT_INTERACTION_UNAVAILABLE")) return "AGENT_INTERACTION_UNAVAILABLE";
  if (hasCode(error, "WORKSPACE_BUSY")) return "WORKSPACE_BUSY";
  if (hasCode(error, "WORKSPACE_REVISION_MISMATCH")) return "WORKSPACE_REVISION_MISMATCH";
  if (hasCode(error, "WORKTREE_POOL_EXHAUSTED")) return "WORKTREE_POOL_EXHAUSTED";
  if (hasCode(error, "SYNC_ALREADY_RUNNING")) return "SYNC_ALREADY_RUNNING";
  if (hasCode(error, "HISTORY_PAUSED")) return "HISTORY_PAUSED";
  if (error instanceof AuthRequiredError || hasCode(error, "AUTH_REQUIRED")) return "AUTH_REQUIRED";
  if (error instanceof AuthInvalidPasswordError || hasCode(error, "AUTH_INVALID_PASSWORD")) {
    return "AUTH_INVALID_PASSWORD";
  }
  if (error instanceof AuthRateLimitedError || hasCode(error, "AUTH_RATE_LIMITED")) {
    return "AUTH_RATE_LIMITED";
  }
  if (hasCode(error, "SYNC_RUN_NOT_FOUND")) return "SYNC_RUN_NOT_FOUND";
  if (hasCode(error, "MAINTENANCE_RUN_NOT_FOUND")) return "MAINTENANCE_RUN_NOT_FOUND";
  return "INTERNAL_ERROR";
}

function isMalformedJsonError(error: unknown): boolean {
  return hasErrorCode(error, "FST_ERR_CTP_INVALID_JSON_BODY");
}

function isUnsupportedContentTypeError(error: unknown): boolean {
  return hasErrorCode(error, "FST_ERR_CTP_INVALID_MEDIA_TYPE");
}

function requestErrorMessage(error: unknown, code: ApiErrorCode): string {
  if (code === "INTERNAL_ERROR") return "Internal server error";
  if (isMalformedJsonError(error)) return "Malformed JSON request body";
  if (isUnsupportedContentTypeError(error)) return "Request body must be empty";
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Invalid request";
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === code
  );
}

function hasCode(
  error: unknown,
  code: Exclude<ApiErrorCode, "INVALID_REQUEST" | "INTERNAL_ERROR">,
): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === code
  );
}
