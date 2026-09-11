/** Browser event emitted when a business API request loses its auth session. */
export const AUTH_REQUIRED_EVENT = "auth-required";

function readErrorCode(body: unknown): unknown {
  if (typeof body !== "object" || body === null) return undefined;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return undefined;
  return (error as { code?: unknown }).code;
}

/**
 * Notify the global auth gate synchronously for the server's auth boundary.
 * The body is intentionally inspected independently of response schema parsing
 * so a valid AUTH_REQUIRED code still locks the UI if another error field is
 * malformed.
 */
export function dispatchAuthRequiredEvent(response: Response, body: unknown): void {
  if (response.status !== 401 || readErrorCode(body) !== "AUTH_REQUIRED") return;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
  }
}
