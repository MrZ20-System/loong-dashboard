import { execa } from "execa";
import { z } from "zod";

import type {
  GitHubAccount,
  GitHubConnectionStatus,
  GitHubFetch,
  GitHubOperation,
  GitHubQuota,
  RepositoryRef,
} from "./provider.js";

/** GraphQL/REST operations surfaced in provider error types. */
export type { GitHubOperation } from "./provider.js";

export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
export const DEFAULT_API_BASE_URL = "https://api.github.com";
export const GRAPHQL_PATH = "graphql";
export const GITHUB_API_VERSION = "2022-11-28";
export const GITHUB_USER_AGENT = "loongboard-github-provider";

/** Common GraphQL error payload accepted by the strict response envelopes. */
export interface GraphQLErrorPayload {
  readonly message: string;
  readonly type?: string;
}

/** Minimal response shape required by the shared GraphQL transport boundary. */
export interface GraphQLResponseEnvelope {
  readonly data?: unknown | null;
  readonly errors?: readonly GraphQLErrorPayload[];
}

export interface GitHubClientOptions {
  readonly ghExecutable: string;
  readonly apiBaseUrl: string;
  readonly fetch: GitHubFetch;
  readonly tokenResolver: (() => string | null | Promise<string | null>) | null;
  readonly commandTimeoutMs: number;
  readonly environment: NodeJS.ProcessEnv;
}

export class GitHubCommandError extends Error {
  readonly command = "gh auth token";
  readonly repository: string;
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(
    repository: string,
    exitCode: number | null,
    stderr: string,
    cause?: unknown,
  ) {
    const detail = stderr.length > 0 ? `: ${truncate(stderr)}` : "";
    super(
      `GitHub auth token command failed for ${repository} (exit code ${exitCode ?? "unknown"})${detail}`,
      { cause },
    );
    this.name = "GitHubCommandError";
    this.repository = repository;
    this.exitCode = exitCode;
    this.stderr = truncate(stderr);
  }
}

export class GitHubResponseError extends Error {
  readonly repository: string;
  readonly operation: GitHubOperation;

  constructor(
    repository: string,
    operation: GitHubOperation,
    message: string,
    cause?: unknown,
  ) {
    super(`GitHub ${operation} response invalid for ${repository}: ${message}`, {
      cause,
    });
    this.name = "GitHubResponseError";
    this.repository = repository;
    this.operation = operation;
  }
}

export class GitHubGraphQLError extends Error {
  readonly repository: string;
  readonly operation: GitHubOperation;
  readonly messages: readonly string[];
  readonly types: readonly string[];

  constructor(
    repository: string,
    operation: GitHubOperation,
    messages: readonly string[],
    types: readonly string[] = [],
  ) {
    super(
      `GitHub ${operation} GraphQL errors for ${repository}: ${messages
        .map((message) => truncate(message))
        .join("; ")}`,
    );
    this.name = "GitHubGraphQLError";
    this.repository = repository;
    this.operation = operation;
    this.messages = messages.map((message) => truncate(message));
    this.types = types.map((type) => truncate(type));
  }
}

/** An HTTP request to GitHub failed at the transport or status layer. */
export class GitHubHttpError extends Error {
  readonly repository: string;
  readonly operation: GitHubOperation;
  readonly method: string;
  readonly url: string;
  readonly status: number | null;

  constructor(
    repository: string,
    operation: GitHubOperation,
    method: string,
    url: string,
    status: number | null,
    detail: string,
    cause?: unknown,
  ) {
    const statusLabel = status === null ? "without an HTTP response" : `HTTP ${status}`;
    const suffix = detail.length > 0 ? `: ${truncate(detail)}` : "";
    super(
      `GitHub ${operation} request ${statusLabel} failed for ${repository} (${method} ${url})${suffix}`,
      { cause },
    );
    this.name = "GitHubHttpError";
    this.repository = repository;
    this.operation = operation;
    this.method = method;
    this.url = url;
    this.status = status;
  }
}

export const githubRateLimitSchema = z
  .object({
    cost: z.number().int().nonnegative(),
    remaining: z.number().int().nonnegative(),
    resetAt: z.string().refine(isDateTime, {
      message: "must be a valid ISO date-time",
    }),
    limit: z.number().int().positive().optional(),
  })
  .strict();

const graphqlErrorSchema = z
  .object({
    message: z.string().min(1),
    type: z.string().optional(),
    path: z.array(z.union([z.string(), z.number().int()])).optional(),
    locations: z
      .array(
        z
          .object({
            line: z.number().int().positive(),
            column: z.number().int().positive(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

const restViewerSchema = z
  .object({
    login: z.string().min(1),
    name: z.string().nullable().optional(),
  });

const connectionResponseSchema = z
  .object({
    data: z
      .object({
        rateLimit: githubRateLimitSchema,
      })
      .strict()
      .nullable()
      .optional(),
    errors: z.array(graphqlErrorSchema).optional(),
  })
  .strict();

const CONNECTION_QUERY = `query GitHubConnection {
  rateLimit { cost remaining resetAt limit }
}`;

type ConnectionResponse = z.infer<typeof connectionResponseSchema>;

/**
 * The only boundary that knows how to obtain a token and speak to GitHub.
 * Feature modules provide concrete queries and response schemas, then use
 * this client for all REST/GraphQL transport and error normalization.
 */
export class GitHubClient {
  private readonly options: GitHubClientOptions;
  private tokenPromise: Promise<string> | null = null;

  constructor(options: GitHubClientOptions) {
    if (options.ghExecutable.length === 0) {
      throw new Error("ghExecutable must not be empty");
    }
    if (options.apiBaseUrl.length === 0) {
      throw new Error("apiBaseUrl must not be empty");
    }
    if (typeof options.fetch !== "function") {
      throw new Error("fetch must be a function");
    }
    if (options.tokenResolver !== null && typeof options.tokenResolver !== "function") {
      throw new Error("tokenResolver must be a function");
    }
    if (!Number.isInteger(options.commandTimeoutMs) || options.commandTimeoutMs <= 0) {
      throw new Error("commandTimeoutMs must be a positive integer");
    }
    this.options = options;
  }

  /** Allow the Settings boundary to apply a replaced credential immediately. */
  clearTokenCache(): void {
    this.tokenPromise = null;
  }

  async requestJson(
    repository: RepositoryRef,
    operation: GitHubOperation,
    method: string,
    path: string,
    body: Record<string, unknown> | null,
  ): Promise<unknown> {
    const result = await this.requestJsonWithHeaders(
      repository,
      operation,
      method,
      path,
      body,
    );
    return result.body;
  }

  async requestJsonWithHeaders(
    repository: RepositoryRef,
    operation: GitHubOperation,
    method: string,
    path: string,
    body: Record<string, unknown> | null,
  ): Promise<{ body: unknown; headers: Headers }> {
    const repositoryLabel = formatRepository(repository);
    const url = githubUrl(this.options.apiBaseUrl, path);
    const token = await this.getToken(repositoryLabel);
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": GITHUB_USER_AGENT,
      "x-github-api-version": GITHUB_API_VERSION,
    };
    if (body !== null) {
      headers["content-type"] = "application/json";
    }

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.options.commandTimeoutMs,
    );
    let response: Response;
    try {
      response = await this.options.fetch(url, {
        method,
        headers,
        body: body === null ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      throw new GitHubHttpError(
        repositoryLabel,
        operation,
        method,
        url,
        null,
        error instanceof Error ? error.message : String(error),
        error,
      );
    }

    let responseText: string;
    try {
      responseText = await response.text();
    } catch (error) {
      clearTimeout(timer);
      throw new GitHubHttpError(
        repositoryLabel,
        operation,
        method,
        url,
        response.status,
        error instanceof Error ? error.message : String(error),
        error,
      );
    }
    clearTimeout(timer);

    if (!response.ok) {
      throw new GitHubHttpError(
        repositoryLabel,
        operation,
        method,
        url,
        response.status,
        responseText,
      );
    }

    try {
      return { body: JSON.parse(responseText) as unknown, headers: response.headers };
    } catch (error) {
      throw new GitHubHttpError(
        repositoryLabel,
        operation,
        method,
        url,
        response.status,
        "response body is not valid JSON",
        error,
      );
    }
  }

  async runGraphQL<TResponse extends GraphQLResponseEnvelope>(
    repository: RepositoryRef,
    operation: GitHubOperation,
    query: string,
    variables: Readonly<Record<string, unknown>>,
    schema: z.ZodType<TResponse>,
  ): Promise<TResponse> {
    const repositoryLabel = formatRepository(repository);
    const decoded = await this.requestJson(
      repository,
      operation,
      "POST",
      GRAPHQL_PATH,
      { query, variables },
    );

    const parsed = schema.safeParse(decoded);
    if (!parsed.success) {
      throw new GitHubResponseError(
        repositoryLabel,
        operation,
        formatSchemaIssues(parsed.error),
      );
    }

    if (parsed.data.errors !== undefined && parsed.data.errors.length > 0) {
      throw new GitHubGraphQLError(
        repositoryLabel,
        operation,
        parsed.data.errors.map((error) => error.message),
        parsed.data.errors
          .map((error) => error.type)
          .filter((type): type is string => type !== undefined),
      );
    }

    if (parsed.data.data === undefined || parsed.data.data === null) {
      throw new GitHubResponseError(
        repositoryLabel,
        operation,
        "data is missing",
      );
    }

    return parsed.data;
  }

  /** Verify credentials and expose only the account and quota projection. */
  async checkConnection(): Promise<GitHubConnectionStatus> {
    const repository = { owner: "github", name: "connection" } as const;
    const [viewerResponse, graphqlResponse] = await Promise.all([
      this.requestJsonWithHeaders(repository, "Connection", "GET", "user", null),
      this.runGraphQL<ConnectionResponse>(
        repository,
        "Connection",
        CONNECTION_QUERY,
        {},
        connectionResponseSchema,
      ),
    ]);
    const viewer = restViewerSchema.safeParse(viewerResponse.body);
    if (!viewer.success) {
      throw new GitHubResponseError(
        "github",
        "Connection",
        formatSchemaIssues(viewer.error),
      );
    }
    const rateLimit = graphqlResponse.data?.rateLimit;
    if (rateLimit === undefined) {
      throw new GitHubResponseError(
        "github",
        "Connection",
        "rateLimit is missing",
      );
    }
    const rest = quotaFromHeaders(viewerResponse.headers);
    const graphql: GitHubQuota = {
      remaining: rateLimit.remaining,
      limit: rateLimit.limit ?? 5_000,
      resetAt: rateLimit.resetAt,
    };
    return {
      account: { login: viewer.data.login, name: viewer.data.name ?? null },
      rest,
      graphql,
    } satisfies GitHubConnectionStatus;
  }

  private async getToken(repositoryLabel: string): Promise<string> {
    if (this.tokenPromise !== null) {
      return this.tokenPromise;
    }
    const promise = this.resolveToken(repositoryLabel);
    this.tokenPromise = promise;
    promise.catch(() => {
      if (this.tokenPromise === promise) {
        this.tokenPromise = null;
      }
    });
    return promise;
  }

  private async resolveToken(repositoryLabel: string): Promise<string> {
    if (this.options.tokenResolver !== null) {
      const configured = await this.options.tokenResolver();
      if (configured !== null) return requireToken(configured);
    }

    const environmentToken = this.options.environment.GH_TOKEN ??
      this.options.environment.GITHUB_TOKEN;
    if (environmentToken !== undefined && environmentToken.trim().length > 0) {
      return environmentToken.trim();
    }
    return this.resolveGhAuthToken(repositoryLabel);
  }

  private async resolveGhAuthToken(repositoryLabel: string): Promise<string> {
    let result: Awaited<ReturnType<typeof execa>>;
    try {
      result = await execa(
        this.options.ghExecutable,
        ["auth", "token"],
        {
          shell: false,
          reject: false,
          timeout: this.options.commandTimeoutMs,
          maxBuffer: 1024 * 1024,
          env: this.options.environment,
        },
      );
    } catch (error) {
      throw new GitHubCommandError(
        repositoryLabel,
        null,
        error instanceof Error ? error.message : String(error),
        error,
      );
    }

    if (result.failed || result.exitCode !== 0) {
      throw new GitHubCommandError(
        repositoryLabel,
        result.exitCode ?? null,
        typeof result.stderr === "string" ? result.stderr : "",
      );
    }

    return requireToken(
      typeof result.stdout === "string" ? result.stdout : "",
    );
  }
}

export function responseError(
  repository: RepositoryRef,
  operation: GitHubOperation,
  message: string,
): GitHubResponseError {
  return new GitHubResponseError(formatRepository(repository), operation, message);
}

export function canonicalUtc(value: Date | string): string {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) {
      throw new Error("GitHub timestamp must be a valid date");
    }
    return value.toISOString();
  }
  if (typeof value !== "string" || !isDateTime(value)) {
    throw new Error("GitHub timestamp must be a valid ISO date-time");
  }
  return new Date(value).toISOString();
}

export function isDateTime(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) && Number.isFinite(Date.parse(value))
  );
}

export function formatRepository(repository: RepositoryRef): string {
  return `${repository.owner}/${repository.name}`;
}

export function formatSchemaIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => {
      const path = issue.path.length === 0 ? "response" : issue.path.join(".");
      return `${path} ${issue.message}`;
    })
    .join("; ");
}

export function unreachableRateLimit(): never {
  throw new Error("GitHub response data is missing rateLimit");
}

function quotaFromHeaders(headers: Headers): GitHubQuota {
  const remaining = Number.parseInt(headers.get("x-ratelimit-remaining") ?? "", 10);
  const limit = Number.parseInt(headers.get("x-ratelimit-limit") ?? "", 10);
  const reset = Number.parseInt(headers.get("x-ratelimit-reset") ?? "", 10);
  return {
    remaining: Number.isInteger(remaining) && remaining >= 0 ? remaining : 0,
    limit: Number.isInteger(limit) && limit > 0 ? limit : 5_000,
    resetAt:
      Number.isInteger(reset) && reset > 0
        ? new Date(reset * 1_000).toISOString()
        : null,
  };
}

function githubUrl(apiBaseUrl: string, path: string): string {
  const base =
    apiBaseUrl.length > 0 && apiBaseUrl.endsWith("/")
      ? apiBaseUrl.slice(0, -1)
      : apiBaseUrl;
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
  return `${base}/${normalizedPath}`;
}

function requireToken(token: string): string {
  const value = token.trim();
  if (value.length === 0) {
    throw new Error("GitHub token resolution returned an empty token");
  }
  return value;
}

function truncate(value: string, maxLength = 4_000): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}
