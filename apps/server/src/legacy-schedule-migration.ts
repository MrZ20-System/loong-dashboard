/**
 * Convert the removed minute-based schedule policy to the canonical cron
 * spelling. This helper is intentionally migration-only; runtime policy and
 * system task projection must receive an already canonical cron expression.
 */
export function legacyIntervalToCron(minutes: number): string {
  if (!Number.isInteger(minutes) || minutes <= 0) {
    throw new Error("Legacy schedule interval must be a positive integer");
  }
  if (minutes < 60) return `*/${minutes} * * * *`;
  if (minutes < 1_440 && minutes % 60 === 0) {
    return `0 */${minutes / 60} * * *`;
  }
  if (minutes % 1_440 === 0) return "0 0 * * *";
  throw new Error(
    "Legacy schedule interval must be a whole number of hours or days",
  );
}
