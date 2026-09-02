export const DEFAULT_API_ORIGIN = "http://127.0.0.1:4174";

/** Resolve the Vite development proxy target from the optional API origin. */
export function resolveApiOrigin(origin?: string): string {
  const configuredOrigin = origin?.trim();
  return configuredOrigin || DEFAULT_API_ORIGIN;
}
