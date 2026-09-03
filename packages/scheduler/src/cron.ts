/**
 * Minimal 5-field cron evaluation (plan 16.1). Supports `*`, exact values,
 * lists (`1,15`), ranges (`9-17`), and `/` steps on every field, in the
 * configured IANA timezone. The next occurrence is found by stepping whole
 * minutes, so DST-transition minute skews are handled naturally.
 */

export type CronField = "minute" | "hour" | "dayOfMonth" | "month" | "dayOfWeek";

export function validateCron(expression: string): void {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Cron expression must have 5 fields, got ${parts.length}`);
  }
  const specs: Array<[CronField, string, [number, number]]> = [
    ["minute", parts[0] ?? "", [0, 59]],
    ["hour", parts[1] ?? "", [0, 23]],
    ["dayOfMonth", parts[2] ?? "", [1, 31]],
    ["month", parts[3] ?? "", [1, 12]],
    ["dayOfWeek", parts[4] ?? "", [0, 7]],
  ];
  for (const [, spec, range] of specs) {
    parseField(spec, range[0], range[1]);
  }
}

function parseField(spec: string, minimum: number, maximum: number): number[] {
  const values = new Set<number>();
  for (const part of spec.split(",")) {
    const trimmed = part.trim();
    if (trimmed === "") throw new Error(`Invalid cron field "${spec}"`);
    const stepMatch = /^(.+?)\/(\d+)$/.exec(trimmed);
    const base = stepMatch === null ? trimmed : (stepMatch[1] ?? "");
    const step = stepMatch === null ? 1 : Number(stepMatch[2]);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid cron step "${trimmed}"`);
    const rangeMatch = /^(\d+)-(\d+)$/.exec(base);
    let start: number;
    let end: number;
    if (rangeMatch !== null) {
      start = Number(rangeMatch[1]);
      end = Number(rangeMatch[2]);
    } else if (base === "*") {
      start = minimum;
      end = maximum;
    } else if (/^\d+$/.test(base)) {
      start = Number(base);
      end = start;
    } else {
      throw new Error(`Invalid cron field value "${base}"`);
    }
    if (start < minimum || end > maximum || start > end) {
      throw new Error(`Cron value ${base} out of range [${minimum}, ${maximum}]`);
    }
    for (let value = start; value <= end; value += step) {
      values.add(value);
    }
  }
  return [...values];
}

export interface CronSchedule {
  expression: string;
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
}

export function parseCron(expression: string): CronSchedule {
  validateCron(expression);
  const [minute, hour, dom, month, dow] = expression.trim().split(/\s+/);
  // Cron treats 7 as Sunday (like 0); normalize both to 0.
  const normalizeDow = (values: number[]): number[] => {
    const set = new Set(values.map((value) => (value === 7 ? 0 : value)));
    return [...set];
  };
  return {
    expression: expression.trim(),
    minutes: parseField(minute ?? "", 0, 59),
    hours: parseField(hour ?? "", 0, 23),
    daysOfMonth: parseField(dom ?? "", 1, 31),
    months: parseField(month ?? "", 1, 12),
    daysOfWeek: normalizeDow(parseField(dow ?? "", 0, 7)),
  };
}

interface ZoneParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

function zoneParts(date: Date, timeZone: string): ZoneParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(date);
  const byType = new Map<string, string>();
  for (const part of parts) byType.set(part.type, part.value);
  const weekdayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  const number = (type: string): number => Number(byType.get(type));
  return {
    year: number("year"),
    month: number("month"),
    day: number("day"),
    hour: number("hour"),
    minute: number("minute"),
    weekday: weekdayMap[byType.get("weekday") ?? ""] ?? 0,
  };
}

function matchesZone(schedule: CronSchedule, parts: ZoneParts): boolean {
  if (!schedule.months.includes(parts.month)) return false;
  if (!schedule.daysOfWeek.includes(parts.weekday)) return false;
  if (!schedule.daysOfMonth.includes(parts.day)) return false;
  if (!schedule.hours.includes(parts.hour)) return false;
  if (!schedule.minutes.includes(parts.minute)) return false;
  return true;
}

/**
 * Next occurrence strictly after `from` matching `expression` in `timeZone`.
 * Steps minute by minute until a match or the search horizon (2 years).
 */
export function nextOccurrence(
  expression: string,
  timeZone: string,
  from: Date = new Date(),
): Date {
  const schedule = parseCron(expression);
  const start = new Date(from.getTime() + 60_000);
  const horizon = start.getTime() + 2 * 366 * 24 * 60 * 60_000;
  const timeZoneKey = timeZone;

  // Step through local calendar minutes deterministically by scanning the
  // instant timeline; Intl resolves DST for us.
  let cursor = new Date(start.getTime() - (start.getTime() % 60_000));
  while (cursor.getTime() <= horizon) {
    if (matchesZone(schedule, zoneParts(cursor, timeZoneKey))) {
      return cursor;
    }
    cursor = new Date(cursor.getTime() + 60_000);
  }
  throw new Error(`No cron occurrence found within the search horizon: ${expression}`);
}
