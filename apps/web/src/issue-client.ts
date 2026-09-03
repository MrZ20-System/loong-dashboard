import { issueDetailSchema, type IssueDetail } from "@loongboard/contracts";

export type IssueFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export async function fetchIssueDetail(
  repositoryId: string,
  number: number,
  fetchImpl: IssueFetch = globalThis.fetch,
): Promise<IssueDetail> {
  let response: Response;
  try {
    response = await fetchImpl(
      `/api/repositories/${encodeURIComponent(repositoryId)}/issues/${number}`,
      { headers: { Accept: "application/json" } },
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`GET issue #${number} failed: ${reason}`);
  }
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body.error?.message) detail = body.error.message;
    } catch {
      // Keep the HTTP status text when the body is not JSON.
    }
    throw new Error(`GET issue #${number} failed with HTTP ${response.status}: ${detail}`);
  }
  const body: unknown = await response.json();
  const parsed = issueDetailSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(`GET issue #${number} returned an invalid response`);
  }
  return parsed.data;
}
