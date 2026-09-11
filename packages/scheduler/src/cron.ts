import { CronExpressionParser } from "cron-parser";

const CRON_FIELD_COUNT = 5;
const CANONICAL_FIELD_PATTERN = /^[0-9*,/-]+$/;

function normalizedExpression(expression: string): string {
  if (typeof expression !== "string") {
    throw new Error("Cron expression must be a string");
  }

  const fields = expression.trim().split(/\s+/);
  if (fields.length !== CRON_FIELD_COUNT || fields.some((field) => field === "")) {
    throw new Error(`Cron expression must have 5 fields, got ${fields.length}`);
  }
  if (fields.some((field) => !CANONICAL_FIELD_PATTERN.test(field))) {
    throw new Error("Cron fields may contain only digits, *, comma, hyphen, and slash");
  }

  // cron-parser tracks `*/1` as a restricted field. The existing LoongBoard
  // semantics treated it as a wildcard for the DOM/DOW OR rule, so normalize
  // those two spellings before delegating to the library.
  if (fields[2] === "*/1") fields[2] = "*";
  if (fields[4] === "*/1") fields[4] = "*";
  return fields.join(" ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseFiveFieldExpression(expression: string): string {
  const normalized = normalizedExpression(expression);
  try {
    CronExpressionParser.parse(normalized);
  } catch (error) {
    throw new Error(`Invalid 5-field cron expression: ${errorMessage(error)}`);
  }
  return normalized;
}

/** Validate a LoongBoard five-field cron expression. */
export function validateCron(expression: string): void {
  parseFiveFieldExpression(expression);
}

function validateTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
  } catch (error) {
    throw new Error(`Invalid IANA timezone "${timeZone}": ${errorMessage(error)}`);
  }
}

/**
 * Return the next occurrence strictly after `from` as an instant in time.
 * cron-parser owns the timezone and DST calculations; this wrapper keeps the
 * public contract restricted to LoongBoard's five-field cron syntax.
 */
export function nextOccurrence(
  expression: string,
  timeZone: string,
  from: Date = new Date(),
): Date {
  const normalized = parseFiveFieldExpression(expression);
  validateTimeZone(timeZone);
  if (!(from instanceof Date) || Number.isNaN(from.getTime())) {
    throw new Error("Cron occurrence start must be a valid Date");
  }

  try {
    const occurrence = CronExpressionParser.parse(normalized, {
      currentDate: from,
      tz: timeZone,
    })
      .next()
      .toDate();
    if (occurrence.getTime() <= from.getTime()) {
      throw new Error("Cron occurrence is not strictly after the start time");
    }
    return occurrence;
  } catch (error) {
    throw new Error(`Unable to calculate next cron occurrence: ${errorMessage(error)}`);
  }
}
