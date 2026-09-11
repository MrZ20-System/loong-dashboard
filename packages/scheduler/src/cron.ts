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
  dayOfMonthWildcard: boolean;
  months: number[];
  daysOfWeek: number[];
  dayOfWeekWildcard: boolean;
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
    dayOfMonthWildcard: dom === "*" || dom === "*/1",
    months: parseField(month ?? "", 1, 12),
    daysOfWeek: normalizeDow(parseField(dow ?? "", 0, 7)),
    dayOfWeekWildcard: dow === "*" || dow === "*/1",
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

function matchesDay(schedule: CronSchedule, parts: ZoneParts): boolean {
  const dayOfMonthMatches = schedule.daysOfMonth.includes(parts.day);
  const dayOfWeekMatches = schedule.daysOfWeek.includes(parts.weekday);
  // POSIX/Vixie cron treats the two day fields specially: when both are
  // restricted, either may match. A wildcard field leaves the other field as
  // the sole day selector.
  return schedule.dayOfMonthWildcard
    ? dayOfWeekMatches
    : schedule.dayOfWeekWildcard
      ? dayOfMonthMatches
      : dayOfMonthMatches || dayOfWeekMatches;
}

function matchesZone(schedule: CronSchedule, parts: ZoneParts): boolean {
  if (!schedule.months.includes(parts.month)) return false;
  if (!matchesDay(schedule, parts)) return false;
  if (!schedule.hours.includes(parts.hour)) return false;
  if (!schedule.minutes.includes(parts.minute)) return false;
  return true;
}

/**
 * Next occurrence strictly after `from` matching `expression` in `timeZone`.
 * Scans exact instants until a match. Months outside the expression can be
 * skipped by whole UTC days; inside a candidate month we retain minute scans
 * so DST gaps, repeats, and non-hour offsets keep their real timeline meaning.
 * The eight-year horizon covers every Gregorian leap-day interval.
 */
export function nextOccurrence(
  expression: string,
  timeZone: string,
  from: Date = new Date(),
): Date {
  const schedule = parseCron(expression);
  const start = new Date(from.getTime() + 60_000);
  const horizon = start.getTime() + 8 * 366 * 24 * 60 * 60_000;
  const timeZoneKey = timeZone;

  // Step through local calendar minutes deterministically by scanning the
  // instant timeline; Intl resolves DST for us.
  let cursor = new Date(start.getTime() - (start.getTime() % 60_000));
  while (cursor.getTime() <= horizon) {
    const parts = zoneParts(cursor, timeZoneKey);
    if (matchesZone(schedule, parts)) {
      return cursor;
    }
    const monthMatches = schedule.months.includes(parts.month);
    const minuteAligned = schedule.minutes.includes(parts.minute);
    // Outside a selected month, a whole UTC day cannot skip the next selected
    // month. Within it, align to one selected minute and then skip non-matching
    // calendar days/hours an hour at a time. A DST offset change may break the
    // minute alignment; the next iteration resumes exact minute scanning.
    const nextDayParts = !monthMatches
      ? zoneParts(new Date(cursor.getTime() + 24 * 60 * 60_000), timeZoneKey)
      : null;
    const step = !monthMatches
      // A 24-hour jump is safe only while the local month remains unchanged.
      // Near a month boundary, scan minutes so e.g. Jan 31 23:31 does not
      // jump over Feb 1 00:00.
      ? nextDayParts?.month === parts.month
        ? 24 * 60 * 60_000
        : 60_000
      : minuteAligned && (!matchesDay(schedule, parts) || !schedule.hours.includes(parts.hour))
        ? 60 * 60_000
        : 60_000;
    cursor = new Date(cursor.getTime() + step);
  }
  throw new Error(`No cron occurrence found within the search horizon: ${expression}`);
}
