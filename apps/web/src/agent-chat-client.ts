import {
  agentMessageAcceptedSchema,
  agentMessagesResponseSchema,
  agentSessionDeleteResponseSchema,
  agentRuntimeEventSchema,
  agentSessionResponseSchema,
  agentSessionsResponseSchema,
  agentInteractionResponseSchema,
  type AgentMessageAccepted,
  type AgentMessagesResponse,
  type AgentRuntimeEvent,
  type AgentScope,
  type AgentSessionResponse,
  type AgentSessionUpdate,
  type AgentSessionsResponse,
} from "@loongboard/contracts";

export type ApiFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

async function requestJson<T>(
  fetchImpl: ApiFetch,
  path: string,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  init?: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(path, {
      headers: { Accept: "application/json", ...(init?.body ? { "Content-Type": "application/json" } : {}) },
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

export function ensureAgentSession(
  scope: AgentScope,
  overrides?: { provider?: string; model?: string; reasoningEffort?: string },
  fetchImpl: ApiFetch = globalThis.fetch,
): Promise<AgentSessionResponse> {
  return requestJson(
    fetchImpl,
    "/api/agent-sessions",
    agentSessionResponseSchema,
    {
      method: "POST",
      body: JSON.stringify({
        scope,
        ...(overrides?.provider ? { provider: overrides.provider } : {}),
        ...(overrides?.model ? { model: overrides.model } : {}),
        ...(overrides?.reasoningEffort ? { reasoningEffort: overrides.reasoningEffort } : {}),
      }),
    },
  );
}

export function fetchAgentSession(
  sessionId: string,
  fetchImpl: ApiFetch = globalThis.fetch,
): Promise<AgentSessionResponse> {
  return requestJson(
    fetchImpl,
    `/api/agent-sessions/${encodeURIComponent(sessionId)}`,
    agentSessionResponseSchema,
  );
}

export function fetchAgentMessages(
  sessionId: string,
  fetchImpl: ApiFetch = globalThis.fetch,
): Promise<AgentMessagesResponse> {
  return requestJson(
    fetchImpl,
    `/api/agent-sessions/${encodeURIComponent(sessionId)}/messages`,
    agentMessagesResponseSchema,
  );
}

export function listAgentSessions(
  params: Record<string, string | number | undefined>,
  fetchImpl: ApiFetch = globalThis.fetch,
): Promise<AgentSessionsResponse> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const suffix = search.toString();
  return requestJson(
    fetchImpl,
    `/api/agent-sessions${suffix ? `?${suffix}` : ""}`,
    agentSessionsResponseSchema,
  );
}

export async function sendAgentMessage(
  sessionId: string,
  content: string,
  fetchImpl: ApiFetch = globalThis.fetch,
): Promise<AgentMessageAccepted> {
  return requestJson(
    fetchImpl,
    `/api/agent-sessions/${encodeURIComponent(sessionId)}/messages`,
    agentMessageAcceptedSchema,
    { method: "POST", body: JSON.stringify({ content }) },
  );
}

export async function cancelAgentTurn(
  sessionId: string,
  fetchImpl: ApiFetch = globalThis.fetch,
): Promise<AgentSessionResponse> {
  return requestJson(
    fetchImpl,
    `/api/agent-sessions/${encodeURIComponent(sessionId)}/cancel`,
    agentSessionResponseSchema,
    { method: "POST" },
  );
}

export function deleteAgentSession(sessionId: string, fetchImpl: ApiFetch = globalThis.fetch): Promise<{ deleted: true }> {
  return requestJson(fetchImpl, `/api/agent-sessions/${encodeURIComponent(sessionId)}`, agentSessionDeleteResponseSchema, { method: "DELETE" });
}

export function updateAgentSession(sessionId: string, patch: AgentSessionUpdate, fetchImpl: ApiFetch = globalThis.fetch): Promise<AgentSessionResponse> {
  return requestJson(fetchImpl, `/api/agent-sessions/${encodeURIComponent(sessionId)}`, agentSessionResponseSchema, { method: "PATCH", body: JSON.stringify(patch) });
}

export async function respondAgentInteraction(
  sessionId: string,
  requestId: string,
  value: string,
  fetchImpl: ApiFetch = globalThis.fetch,
): Promise<void> {
  const body = agentInteractionResponseSchema.parse({ value });
  const response = await fetchImpl(
    `/api/agent-sessions/${encodeURIComponent(sessionId)}/interactions/${encodeURIComponent(requestId)}`,
    { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const errorBody = (await response.json()) as { error?: { message?: string } };
      if (errorBody.error?.message) detail = errorBody.error.message;
    } catch {
      // Keep the HTTP status text when the error body is not JSON.
    }
    throw new Error(`POST interaction failed with HTTP ${response.status}: ${detail}`);
  }
}

export async function syncAgentWorkspace(
  sessionId: string,
  fetchImpl: ApiFetch = globalThis.fetch,
): Promise<AgentSessionResponse> {
  return requestJson(
    fetchImpl,
    `/api/agent-sessions/${encodeURIComponent(sessionId)}/workspace`,
    agentSessionResponseSchema,
    { method: "POST" },
  );
}

/**
 * Open the session SSE stream. Returns a cleanup function. `onEvent` receives
 * every validated runtime event; transport errors surface as an `error` event
 * through `onError` (EventSource auto-reconnects by design).
 */
export function connectAgentEvents(
  sessionId: string,
  onEvent: (event: AgentRuntimeEvent) => void,
  onError?: (error: Error) => void,
): () => void {
  const source = new EventSource(
    `/api/agent-sessions/${encodeURIComponent(sessionId)}/events`,
  );
  source.onmessage = (message: MessageEvent<string>) => {
    try {
      const parsed = agentRuntimeEventSchema.safeParse(JSON.parse(message.data) as unknown);
      if (parsed.success) onEvent(parsed.data);
    } catch {
      // Ignore malformed frames; the reconnect loop keeps the stream healthy.
    }
  };
  source.onerror = () => {
    onError?.(new Error("Agent event stream disconnected"));
  };
  return () => source.close();
}
