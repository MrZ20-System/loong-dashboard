interface CalendarParts {
  year: number;
  month: number;
  day: number;
}

interface ZonedParts extends CalendarParts {
  hour: number;
  minute: number;
  second: number;
}

export interface UtcDateRange {
  from: string;
  to: string;
}

const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;

function calendarPartsAsUtcMillis(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): number {
  // Date.UTC treats years 0 through 99 as 1900 through 1999. Constructing a
  // zero-date and assigning the full year keeps the documented YYYY range
  // correct for historical dates as well.
  const result = new Date(0);
  result.setUTCFullYear(year, month - 1, day);
  result.setUTCHours(hour, minute, second, 0);
  return result.getTime();
}

function parseCalendarDate(value: string): CalendarParts {
  const match = datePattern.exec(value);
  if (!match) {
    throw new Error(`Invalid calendar date: ${value}`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) {
    throw new Error(`Invalid calendar date: ${value}`);
  }

  return { year, month, day };
}

function assertTimeZone(timeZone: string): void {
  if (timeZone.trim().length === 0) {
    throw new Error("Calendar timezone must not be empty");
  }

  try {
    // Constructing the formatter is the platform's IANA timezone validator.
    new Intl.DateTimeFormat("en-CA", { timeZone }).format();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid calendar timezone ${timeZone}: ${reason}`);
  }
}

function getZonedParts(instant: number, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    calendar: "iso8601",
    numberingSystem: "latn",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(new Date(instant))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function timeZoneOffsetMillis(instant: number, timeZone: string): number {
  const local = getZonedParts(instant, timeZone);
  const localAsUtc = calendarPartsAsUtcMillis(
    local.year,
    local.month,
    local.day,
    local.hour,
    local.minute,
    local.second,
  );
  return localAsUtc - Math.floor(instant / 1_000) * 1_000;
}

function localMidnightUtc(date: string, timeZone: string): Date {
  const local = parseCalendarDate(date);
  const localAsUtc = calendarPartsAsUtcMillis(local.year, local.month, local.day);
  let candidate = localAsUtc;

  // Offset changes near midnight are uncommon but legal in IANA data. A few
  // fixed-point iterations account for both ordinary DST transitions and
  // historical non-hour offsets without a third-party timezone dependency.
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const next = localAsUtc - timeZoneOffsetMillis(candidate, timeZone);
    if (next === candidate) {
      return new Date(next);
    }
    candidate = next;
  }

  return new Date(candidate);
}

function addCalendarDays(date: string, days: number): string {
  const parsed = parseCalendarDate(date);
  const result = new Date(calendarPartsAsUtcMillis(parsed.year, parsed.month, parsed.day));
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

/** Convert an inclusive local-date range to a UTC half-open range. */
export function calendarDateRangeToUtc(
  fromDate: string,
  toDate: string,
  timeZone: string,
): UtcDateRange {
  const from = parseCalendarDate(fromDate);
  const to = parseCalendarDate(toDate);
  const fromOrdinal = calendarPartsAsUtcMillis(from.year, from.month, from.day);
  const toOrdinal = calendarPartsAsUtcMillis(to.year, to.month, to.day);
  if (fromOrdinal > toOrdinal) {
    throw new Error("Calendar range from must be on or before to");
  }

  assertTimeZone(timeZone);
  return {
    from: localMidnightUtc(fromDate, timeZone).toISOString(),
    to: localMidnightUtc(addCalendarDays(toDate, 1), timeZone).toISOString(),
  };
}

/** Convert a single local calendar date to its UTC half-open day range. */
export function calendarDateToUtc(date: string, timeZone: string): UtcDateRange {
  return calendarDateRangeToUtc(date, date, timeZone);
}

/** Format a persisted UTC instant as a local calendar date. */
export function utcDateToCalendarDate(utcDateTime: string, timeZone: string): string {
  const timestamp = Date.parse(utcDateTime);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid UTC timestamp: ${utcDateTime}`);
  }
  assertTimeZone(timeZone);
  const parts = getZonedParts(timestamp, timeZone);
  return [parts.year, parts.month, parts.day]
    .map((part, index) => (index === 0 ? String(part).padStart(4, "0") : String(part).padStart(2, "0")))
    .join("-");
}

export function addDaysToCalendarDate(date: string, days: number): string {
  parseCalendarDate(date);
  if (!Number.isInteger(days)) {
    throw new Error("Calendar day offset must be an integer");
  }
  return addCalendarDays(date, days);
}
