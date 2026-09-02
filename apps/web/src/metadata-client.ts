export type RepositorySummary = {
  id: string;
  key?: string;
  name: string;
  github: string;
  defaultBranch?: string;
  enabled?: boolean;
};

export type PullRequestListItem = {
  repositoryId: string;
  number: number;
  title: string;
  url: string;
  authorLogin: string | null;
  status: "draft" | "open" | "closed" | "merged";
  updatedAt: string;
  changedFilesCount: number;
  additions: number;
  deletions: number;
};

export type IssueListItem = {
  repositoryId: string;
  number: number;
  title: string;
  url: string;
  authorLogin: string | null;
  status: "open" | "closed";
  commentsCount: number;
  updatedAt: string;
};

export type ListResponse<T> = {
  items: T[];
  nextCursor: string | null;
  calendarTimeZone: string;
};

export type SyncStreamState = {
  status: "idle" | "running" | "succeeded" | "failed";
  error?: string | null;
  fetched?: number;
  written?: number;
};

export type SyncStatusResponse = {
  repositoryId: string;
  status: "idle" | "running" | "failed";
  pullRequests: SyncStreamState;
  issues: SyncStreamState;
};

export type SyncAcceptedResponse = {
  repositoryId: string;
  syncRunId: string;
  status: "accepted";
};

export type ApiErrorBody = {
  error: { code: string; message: string };
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
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function normalizeFilter(
  value: string | null,
  allowed: readonly string[],
): string | null {
  return value && allowed.includes(value) ? value : null;
}

export function buildListUrl(
  repositoryId: string,
  kind: "pulls" | "issues",
  filters: { date?: string | null; status?: string | null; cursor?: string | null },
): string {
  const query = new URLSearchParams();
  if (filters.date) query.set("date", filters.date);
  if (filters.status) query.set("status", filters.status);
  if (filters.cursor) query.set("cursor", filters.cursor);
  const search = query.toString();
  return `/api/repositories/${encodeURIComponent(repositoryId)}/${kind}${search ? `?${search}` : ""}`;
}

async function request<T>(
  url: string,
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
    const apiError = body as Partial<ApiErrorBody>;
    const detail = apiError.error;
    throw new ApiRequestError(
      detail?.message ?? `${init.method ?? "GET"} ${url} failed with HTTP ${response.status}`,
      response.status,
      detail?.code ?? null,
    );
  }
  return body as T;
}

function invalidResponse(url: string): never {
  throw new ApiRequestError(`${url} returned an invalid response`, 200);
}

function normalizeRepositories(body: unknown): { items: RepositorySummary[] } {
  if (!body || typeof body !== "object" || !Array.isArray((body as { items?: unknown }).items)) {
    return invalidResponse("GET /api/repositories");
  }
  const items = (body as { items: unknown[] }).items.map((value) => {
    if (!value || typeof value !== "object") return invalidResponse("GET /api/repositories");
    const item = value as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id : typeof item.key === "string" ? item.key : null;
    const name = typeof item.name === "string" ? item.name : typeof item.displayName === "string" ? item.displayName : null;
    const github = typeof item.github === "string" ? item.github : typeof item.githubOwner === "string" && typeof item.githubName === "string" ? `${item.githubOwner}/${item.githubName}` : null;
    if (!id || !name || !github) return invalidResponse("GET /api/repositories");
    return { id, key: typeof item.key === "string" ? item.key : undefined, name, github, defaultBranch: typeof item.defaultBranch === "string" ? item.defaultBranch : undefined, enabled: typeof item.enabled === "boolean" ? item.enabled : undefined };
  });
  return { items };
}

function normalizeList<T>(url: string, body: unknown): ListResponse<T> {
  if (!body || typeof body !== "object") return invalidResponse(`GET ${url}`);
  const value = body as Record<string, unknown>;
  if (!Array.isArray(value.items) || (value.nextCursor !== null && typeof value.nextCursor !== "string") || typeof value.calendarTimeZone !== "string") {
    return invalidResponse(`GET ${url}`);
  }
  return { items: value.items as T[], nextCursor: value.nextCursor as string | null, calendarTimeZone: value.calendarTimeZone };
}

export function fetchRepositories(
  signal?: AbortSignal,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<{ items: RepositorySummary[] }> {
  return request<unknown>("/api/repositories", { signal }, fetchImpl).then(normalizeRepositories);
}

export function fetchList<T>(
  repositoryId: string,
  kind: "pulls" | "issues",
  filters: { date?: string | null; status?: string | null; cursor?: string | null },
  signal?: AbortSignal,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<ListResponse<T>> {
  const url = buildListUrl(repositoryId, kind, filters);
  return request<unknown>(url, { signal }, fetchImpl).then((body) => normalizeList<T>(url, body));
}

export function fetchSyncStatus(
  repositoryId: string,
  signal?: AbortSignal,
): Promise<SyncStatusResponse> {
  return request<SyncStatusResponse>(
    `/api/repositories/${encodeURIComponent(repositoryId)}/sync-status`,
    { signal },
  );
}

export function startSync(
  repositoryId: string,
  signal?: AbortSignal,
): Promise<SyncAcceptedResponse> {
  return request<SyncAcceptedResponse>(
    `/api/repositories/${encodeURIComponent(repositoryId)}/sync`,
    { method: "POST", signal },
  );
}
