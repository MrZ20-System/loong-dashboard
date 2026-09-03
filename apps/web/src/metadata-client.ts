import {
  apiErrorSchema,
  calendarDateSchema,
  domainRuleIdSchema,
  issueStatusSchema,
  issuesQuerySchema,
  issuesResponseSchema,
  pullRequestStatusSchema,
  pullRequestsQuerySchema,
  repositoriesResponseSchema,
  pullRequestsResponseSchema,
  syncAcceptedResponseSchema,
  syncStatusResponseSchema,
  type IssuesResponse,
  type IssueListItem,
  type PullRequestsResponse,
  type PullRequestListItem,
  type RepositorySummary,
  type RepositoriesResponse,
  type SyncAcceptedResponse,
  type SyncStatusResponse,
} from "@loongboard/contracts";

export type { IssueListItem, PullRequestListItem, RepositorySummary } from "@loongboard/contracts";

export type MetadataFilters = {
  date: string | null;
  status: string | null;
  /** Repeated `?domain=` values; pull request lists only. */
  domains: string[];
};

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
  }
}

export function isValidDate(value: string | null): value is string {
  return calendarDateSchema.safeParse(value).success;
}

export function readMetadataFilters(
  kind: "pulls" | "issues",
  params: URLSearchParams,
): MetadataFilters {
  const dateValue = params.get("date");
  const statusValue = params.get("status");
  const rawDomainValues = kind === "pulls" ? params.getAll("domain") : [];
  const querySchema = kind === "pulls" ? pullRequestsQuerySchema : issuesQuerySchema;
  const candidate: Record<string, unknown> = {};
  if (dateValue !== null) candidate.date = dateValue;
  if (statusValue !== null) candidate.status = statusValue;
  if (rawDomainValues.length > 0) candidate.domain = rawDomainValues;
  const parsed = querySchema.safeParse(candidate);
  if (parsed.success) {
    const data = parsed.data as { date?: string; status?: string; domain?: string[] };
    return {
      date: data.date ?? null,
      status: data.status ?? null,
      domains: kind === "pulls" ? (data.domain ?? []) : [],
    };
  }
  const statusSchema = kind === "pulls" ? pullRequestStatusSchema : issueStatusSchema;
  return {
    date: isValidDate(dateValue) ? dateValue : null,
    status: statusSchema.safeParse(statusValue).success ? statusValue : null,
    domains: rawDomainValues
      .filter((value) => domainRuleIdSchema.safeParse(value).success)
      .slice(0, 20),
  };
}

export function buildListUrl(
  repositoryId: string,
  kind: "pulls" | "issues",
  filters: { date?: string | null; status?: string | null; cursor?: string | null; domains?: string[] | null },
): string {
  const query = new URLSearchParams();
  if (filters.date) query.set("date", filters.date);
  if (filters.status) query.set("status", filters.status);
  for (const domain of filters.domains ?? []) query.append("domain", domain);
  if (filters.cursor) query.set("cursor", filters.cursor);
  const search = query.toString();
  return `/api/repositories/${encodeURIComponent(repositoryId)}/${kind}${search ? `?${search}` : ""}`;
}

type ParseSchema<T> = { parse: (input: unknown) => T };

export async function request<T>(
  url: string,
  schema: ParseSchema<T>,
  init: RequestInit = {},
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      headers: { Accept: "application/json", ...init.headers },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new ApiRequestError(`${init.method ?? "GET"} ${url} failed: ${reason}`, 0);
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    if (!response.ok) {
      throw new ApiRequestError(
        `${init.method ?? "GET"} ${url} failed with HTTP ${response.status}`,
        response.status,
      );
    }
  }

  if (!response.ok) {
    const parsedError = apiErrorSchema.safeParse(body);
    const detail = parsedError.success ? parsedError.data.error : undefined;
    throw new ApiRequestError(
      detail?.message ?? `${init.method ?? "GET"} ${url} failed with HTTP ${response.status}`,
      response.status,
      detail?.code ?? null,
    );
  }
  try {
    return schema.parse(body);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ApiRequestError(`${init.method ?? "GET"} ${url} returned an invalid response: ${reason}`, response.status);
  }
}

export function fetchRepositories(
  signal?: AbortSignal,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<RepositoriesResponse> {
  return request("/api/repositories", repositoriesResponseSchema, { signal }, fetchImpl);
}

export function fetchList(
  repositoryId: string,
  kind: "pulls" | "issues",
  filters: { date?: string | null; status?: string | null; cursor?: string | null; domains?: string[] | null },
  signal?: AbortSignal,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<PullRequestsResponse | IssuesResponse> {
  const url = buildListUrl(repositoryId, kind, filters);
  return kind === "pulls"
    ? request(url, pullRequestsResponseSchema, { signal }, fetchImpl)
    : request(url, issuesResponseSchema, { signal }, fetchImpl);
}

export function fetchSyncStatus(
  repositoryId: string,
  signal?: AbortSignal,
): Promise<SyncStatusResponse> {
  return request<SyncStatusResponse>(
    `/api/repositories/${encodeURIComponent(repositoryId)}/sync-status`,
    syncStatusResponseSchema,
    { signal },
  );
}

export function startSync(
  repositoryId: string,
  signal?: AbortSignal,
): Promise<SyncAcceptedResponse> {
  return request<SyncAcceptedResponse>(
    `/api/repositories/${encodeURIComponent(repositoryId)}/sync`,
    syncAcceptedResponseSchema,
    { method: "POST", signal },
  );
}
