import {
  knowledgeDocumentSchema,
  knowledgeTreeResponseSchema,
  knowledgeVersionsResponseSchema,
  type KnowledgeDocument,
  type KnowledgeTreeResponse,
  type KnowledgeVersionsResponse,
} from "@loongboard/contracts";

export type KnowledgeFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

async function requestJson<T>(
  fetchImpl: KnowledgeFetch,
  path: string,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  init?: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(path, {
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
      },
      ...init,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${init?.method ?? "GET"} ${path} failed: ${reason}`);
  }
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body.error?.message) detail = body.error.message;
    } catch {
      // Keep the HTTP status text when the error body is not JSON.
    }
    throw new Error(`${init?.method ?? "GET"} ${path} failed with HTTP ${response.status}: ${detail}`);
  }
  const body: unknown = await response.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new Error(`${init?.method ?? "GET"} ${path} returned an invalid response`);
  }
  return parsed.data;
}

export function fetchKnowledgeTree(fetchImpl: KnowledgeFetch = globalThis.fetch): Promise<KnowledgeTreeResponse> {
  return requestJson(fetchImpl, "/api/knowledge/tree", knowledgeTreeResponseSchema);
}

export function fetchKnowledgeDocument(
  path: string,
  fetchImpl: KnowledgeFetch = globalThis.fetch,
): Promise<KnowledgeDocument> {
  return requestJson(
    fetchImpl,
    `/api/knowledge/documents?path=${encodeURIComponent(path)}`,
    knowledgeDocumentSchema,
  );
}

export function createKnowledgeDocument(
  input: { path: string; title: string; content: string },
  fetchImpl: KnowledgeFetch = globalThis.fetch,
): Promise<KnowledgeDocument> {
  return requestJson(fetchImpl, "/api/knowledge/documents", knowledgeDocumentSchema, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function saveKnowledgeDocument(
  path: string,
  content: string,
  fetchImpl: KnowledgeFetch = globalThis.fetch,
): Promise<KnowledgeDocument> {
  return requestJson(
    fetchImpl,
    `/api/knowledge/documents?path=${encodeURIComponent(path)}`,
    knowledgeDocumentSchema,
    { method: "PUT", body: JSON.stringify({ content }) },
  );
}

export function moveKnowledgeDocument(
  id: string,
  path: string,
  fetchImpl: KnowledgeFetch = globalThis.fetch,
): Promise<KnowledgeDocument> {
  return requestJson(
    fetchImpl,
    `/api/knowledge/documents/${encodeURIComponent(id)}/move`,
    knowledgeDocumentSchema,
    { method: "POST", body: JSON.stringify({ path }) },
  );
}

export async function deleteKnowledgeDocument(
  id: string,
  fetchImpl: KnowledgeFetch = globalThis.fetch,
): Promise<void> {
  await requestJson(
    fetchImpl,
    `/api/knowledge/documents/${encodeURIComponent(id)}`,
    { safeParse: () => ({ success: true as const, data: undefined as never }) },
    { method: "DELETE" },
  );
}

export function fetchKnowledgeVersions(
  id: string,
  fetchImpl: KnowledgeFetch = globalThis.fetch,
): Promise<KnowledgeVersionsResponse> {
  return requestJson(
    fetchImpl,
    `/api/knowledge/documents/${encodeURIComponent(id)}/versions`,
    knowledgeVersionsResponseSchema,
  );
}

export function restoreKnowledgeVersion(
  id: string,
  versionId: string,
  fetchImpl: KnowledgeFetch = globalThis.fetch,
): Promise<KnowledgeDocument> {
  return requestJson(
    fetchImpl,
    `/api/knowledge/documents/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}/restore`,
    knowledgeDocumentSchema,
    { method: "POST" },
  );
}

/** Ensure the document's default chat and return its session id. */
export async function ensureDocumentChat(
  id: string,
  fetchImpl: KnowledgeFetch = globalThis.fetch,
): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl(`/api/knowledge/documents/${encodeURIComponent(id)}/chat`, {
      method: "POST",
      headers: { Accept: "application/json" },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`POST document chat failed: ${reason}`);
  }
  if (!response.ok) {
    throw new Error(`POST document chat failed with HTTP ${response.status}`);
  }
  const body = (await response.json()) as { session?: { id?: string } };
  const sessionId = body.session?.id;
  if (typeof sessionId !== "string") {
    throw new Error("POST document chat returned an invalid response");
  }
  return sessionId;
}
