import {
  healthResponseSchema,
  type HealthResponse,
} from "@loongboard/contracts";

export type HealthFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export async function fetchHealth(
  fetchImpl: HealthFetch = globalThis.fetch,
): Promise<HealthResponse> {
  let response: Response;

  try {
    response = await fetchImpl("/api/health", {
      headers: { Accept: "application/json" },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`GET /api/health failed: ${reason}`);
  }

  if (!response.ok) {
    throw new Error(
      `GET /api/health failed with HTTP ${response.status} ${response.statusText}`.trim(),
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`GET /api/health returned invalid JSON: ${reason}`);
  }

  const parsed = healthResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(
      `GET /api/health returned an invalid response: ${parsed.error.message}`,
    );
  }

  return parsed.data;
}
