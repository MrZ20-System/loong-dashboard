import {
  scheduledTaskRunsResponseSchema,
  scheduledTasksResponseSchema,
  scheduledTaskSchema,
  type ScheduledTask,
  type ScheduledTaskRunsResponse,
  type ScheduledTasksResponse,
} from "@loongboard/contracts";

export type ScheduleFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

async function requestJson<T>(
  fetchImpl: ScheduleFetch,
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

export type TaskDraft = {
  name: string;
  cronExpression: string;
  timezone: string;
  prompt: string;
  workspacePath: string;
  enabled: boolean;
};

export function fetchScheduledTasks(fetchImpl: ScheduleFetch = globalThis.fetch): Promise<ScheduledTasksResponse> {
  return requestJson(fetchImpl, "/api/scheduled-tasks", scheduledTasksResponseSchema);
}

export function createScheduledTask(input: TaskDraft, fetchImpl: ScheduleFetch = globalThis.fetch): Promise<ScheduledTask> {
  return requestJson(fetchImpl, "/api/scheduled-tasks", scheduledTaskSchema, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateScheduledTask(
  id: string,
  patch: Partial<TaskDraft>,
  fetchImpl: ScheduleFetch = globalThis.fetch,
): Promise<ScheduledTask> {
  return requestJson(fetchImpl, `/api/scheduled-tasks/${encodeURIComponent(id)}`, scheduledTaskSchema, {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

export async function deleteScheduledTask(id: string, fetchImpl: ScheduleFetch = globalThis.fetch): Promise<void> {
  await requestJson(
    fetchImpl,
    `/api/scheduled-tasks/${encodeURIComponent(id)}`,
    { safeParse: () => ({ success: true as const, data: undefined as never }) },
    { method: "DELETE" },
  );
}

export async function runScheduledTask(id: string, fetchImpl: ScheduleFetch = globalThis.fetch): Promise<{ runId: string }> {
  const body = (await requestJson(
    fetchImpl,
    `/api/scheduled-tasks/${encodeURIComponent(id)}/run`,
    { safeParse: (value: unknown) => ({ success: true as const, data: value as { runId: string } }) },
    { method: "POST" },
  )) as unknown as { runId: string };
  return body;
}

export function fetchScheduledTaskRuns(
  id: string,
  fetchImpl: ScheduleFetch = globalThis.fetch,
): Promise<ScheduledTaskRunsResponse> {
  return requestJson(
    fetchImpl,
    `/api/scheduled-tasks/${encodeURIComponent(id)}/runs`,
    scheduledTaskRunsResponseSchema,
  );
}
