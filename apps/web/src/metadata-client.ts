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
  mergedPullRequestsQuerySchema,
  mergedPullRequestsResponseSchema,
  syncAcceptedResponseSchema,
  syncStatusResponseSchema,
  type IssuesResponse,
  type IssueListItem,
  type PullRequestsResponse,
  type PullRequestListItem,
  type MergedPullRequestsResponse,
  type RepositorySummary,
  type RepositoriesResponse,
  type SyncAcceptedResponse,
  type SyncStatusResponse,
} from "@loongboard/contracts";

export type { IssueListItem, PullRequestListItem, RepositorySummary } from "@loongboard/contracts";

export type DateRange = {
  from: string | null;
  to: string | null;
};

export type MetadataFilters = {
  from: string | null;
  to: string | null;
  status: string | null;
  search: string;
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

/** Read a complete range, with a fallback for malformed or legacy URLs. */
export function readDateRange(
  params: URLSearchParams,
  fallback: DateRange,
): DateRange {
  const legacyDate = params.get("date");
  const rawFrom = params.get("from");
  const rawTo = params.get("to");
  if (rawFrom === null && rawTo === null) {
    if (legacyDate !== null && isValidDate(legacyDate)) {
      return { from: legacyDate, to: legacyDate };
    }
    return fallback;
  }
  if (!isValidDate(rawFrom) || !isValidDate(rawTo) || rawFrom > rawTo) {
    return fallback;
  }
  return { from: rawFrom, to: rawTo };
}

export function readMetadataFilters(
  kind: "pulls" | "issues",
  params: URLSearchParams,
): MetadataFilters {
  const fromValue = params.get("from");
  const toValue = params.get("to");
  const dateValue = params.get("date");
  const statusValue = params.get("status");
  const searchValue = params.get("search") ?? "";
  const rawDomainValues = kind === "pulls" ? params.getAll("domain") : [];
  const querySchema = kind === "pulls" ? pullRequestsQuerySchema : issuesQuerySchema;
  const candidate: Record<string, unknown> = {};
  if (fromValue !== null) candidate.from = fromValue;
  if (toValue !== null) candidate.to = toValue;
  if (dateValue !== null) candidate.date = dateValue;
  if (statusValue !== null) candidate.status = statusValue;
  if (rawDomainValues.length > 0) candidate.domain = rawDomainValues;
  const parsed = querySchema.safeParse(candidate);
  if (parsed.success) {
    const data = parsed.data as { from?: string; to?: string; status?: string; domain?: string[] };
    return {
      from: data.from ?? null,
      to: data.to ?? null,
      status: data.status ?? null,
      search: searchValue,
      domains: kind === "pulls" ? (data.domain ?? []) : [],
    };
  }
  const statusSchema = kind === "pulls" ? pullRequestStatusSchema : issueStatusSchema;
  const legacyDate = isValidDate(dateValue) ? dateValue : null;
  const from = fromValue === null ? legacyDate : isValidDate(fromValue) ? fromValue : null;
  const to = toValue === null ? legacyDate : isValidDate(toValue) ? toValue : null;
  const validOrder = from === null || to === null || from <= to;
  return {
    from: validOrder ? from : null,
    to: validOrder ? to : null,
    status: statusSchema.safeParse(statusValue).success ? statusValue : null,
    search: searchValue,
    domains: rawDomainValues
      .filter((value) => domainRuleIdSchema.safeParse(value).success)
      .slice(0, 20),
  };
}

export function buildListUrl(
  repositoryId: string,
  kind: "pulls" | "issues",
  filters: {
    from?: string | null;
    to?: string | null;
    /** Accepted for callers that still pass the pre-range shape. */
    date?: string | null;
    status?: string | null;
    search?: string | null;
    sort?: "updated" | "number" | null;
    limit?: number | null;
    page?: number | null;
    cursor?: string | null;
    domains?: string[] | null;
  },
): string {
  const query = new URLSearchParams();
  const from = filters.from ?? filters.date ?? null;
  const to = filters.to ?? filters.date ?? null;
  if (from) query.set("from", from);
  if (to) query.set("to", to);
  if (filters.status) query.set("status", filters.status);
  if (filters.search) query.set("search", filters.search);
  if (filters.sort) query.set("sort", filters.sort);
  if (filters.limit) query.set("limit", String(filters.limit));
  if (kind === "pulls" && filters.page) query.set("page", String(filters.page));
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
  filters: {
    from?: string | null;
    to?: string | null;
    date?: string | null;
    status?: string | null;
    search?: string | null;
    sort?: "updated" | "number" | null;
    limit?: number | null;
    page?: number | null;
    cursor?: string | null;
    domains?: string[] | null;
  },
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

export function fetchMergedPullRequests(
  repositoryId: string,
  range: {
    search?: string | null;
    domains?: string[] | null;
    page?: number | null;
    limit?: number | null;
  } = {},
  signal?: AbortSignal,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<MergedPullRequestsResponse> {
  const query = mergedPullRequestsQuerySchema.parse({
    ...(range.search ? { search: range.search } : {}),
    ...(range.page ? { page: range.page } : {}),
    ...(range.limit ? { limit: range.limit } : {}),
    ...(range.domains?.length ? { domain: range.domains } : {}),
  });
  const params = new URLSearchParams();
  if (query.search) params.set("search", query.search);
  for (const domain of query.domain ?? []) params.append("domain", domain);
  if (query.page) params.set("page", String(query.page));
  if (query.limit) params.set("limit", String(query.limit));
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return request(
    `/api/repositories/${encodeURIComponent(repositoryId)}/merged${suffix}`,
    mergedPullRequestsResponseSchema,
    { signal },
    fetchImpl,
  );
}
