import {
  authPasswordUpdateSchema,
  authStatusSchema,
  authUnlockRequestSchema,
  type AuthPasswordUpdate,
  type AuthStatus,
} from "@loongboard/contracts";

async function request<T>(
  path: string,
  schema: { parse(value: unknown): T },
  init: RequestInit = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...init.headers,
      },
    });
  } catch (error) {
    throw new Error(`Authentication request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = typeof body === "object" && body !== null && "error" in body
      ? String((body as { error?: { message?: unknown } }).error?.message ?? response.statusText)
      : response.statusText;
    throw new Error(detail || "Authentication request failed");
  }
  return schema.parse(body);
}

export function fetchAuthStatus(signal?: AbortSignal): Promise<AuthStatus> {
  return request("/api/auth/status", authStatusSchema, { signal });
}

export function unlockAuth(password: string): Promise<AuthStatus> {
  const input = authUnlockRequestSchema.parse({ password });
  return request("/api/auth/unlock", authStatusSchema, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateAuthPassword(input: AuthPasswordUpdate): Promise<AuthStatus> {
  const parsed = authPasswordUpdateSchema.parse(input);
  return request("/api/auth/password", authStatusSchema, {
    method: "POST",
    body: JSON.stringify(parsed),
  });
}

export function disableAuth(): Promise<AuthStatus> {
  return request("/api/auth/disable", authStatusSchema, { method: "POST" });
}

export function logoutAuth(): Promise<AuthStatus> {
  return request("/api/auth/logout", authStatusSchema, { method: "POST" });
}
