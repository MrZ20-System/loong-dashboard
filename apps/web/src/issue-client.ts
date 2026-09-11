import { issueDetailSchema, type IssueDetail } from "@loongboard/contracts";
import { dispatchAuthRequiredEvent } from "./auth-required-event";

export type IssueFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export async function fetchIssueDetail(
  repositoryId: string,
  number: number,
  fetchImpl: IssueFetch = globalThis.fetch,
): Promise<IssueDetail> {
  return requestIssueDetail(repositoryId, number, "GET", fetchImpl);
}

/** Explicit GitHub refresh for a cached Issue payload. */
export async function refreshIssueDetail(
  repositoryId: string,
  number: number,
  fetchImpl: IssueFetch = globalThis.fetch,
): Promise<IssueDetail> {
  return requestIssueDetail(repositoryId, number, "POST", fetchImpl);
}

async function requestIssueDetail(
  repositoryId: string,
  number: number,
  method: "GET" | "POST",
  fetchImpl: IssueFetch,
): Promise<IssueDetail> {
  const path = `/api/repositories/${encodeURIComponent(repositoryId)}/issues/${number}${method === "POST" ? "/refresh" : ""}`;
  let response: Response;
  try {
    response = await fetchImpl(path, {
      ...(method === "POST" ? { method } : {}),
      headers: { Accept: "application/json" },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${method} issue #${number} failed: ${reason}`);
  }
  if (!response.ok) {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // Keep the HTTP status text when the body is not JSON.
    }
    dispatchAuthRequiredEvent(response, body);
    const detail =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error?: { message?: unknown } }).error?.message ?? response.statusText)
        : response.statusText;
    throw new Error(`${method} issue #${number} failed with HTTP ${response.status}: ${detail}`);
  }
  const body: unknown = await response.json();
  const parsed = issueDetailSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(`${method} issue #${number} returned an invalid response`);
  }
  return parsed.data;
}
