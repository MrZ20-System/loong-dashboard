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
const MILLIS_PER_DAY = 86_400_000;
const MAX_BOUNDARY_SEARCH_DAYS = 370;

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

function createDateFormatter(timeZone: string): Intl.DateTimeFormat {
  if (timeZone.trim().length === 0) {
    throw new Error("Calendar timezone must not be empty");
  }

  try {
    // Constructing the formatter is the platform's IANA timezone validator.
    return new Intl.DateTimeFormat("en-CA", {
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
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid calendar timezone ${timeZone}: ${reason}`);
  }
}

function getZonedParts(instant: number, formatter: Intl.DateTimeFormat): ZonedParts {
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

function localDateOrdinal(instant: number, formatter: Intl.DateTimeFormat): number {
  const local = getZonedParts(instant, formatter);
  return calendarPartsAsUtcMillis(local.year, local.month, local.day);
}

/**
 * Find the first instant whose projected local calendar date is at or after
 * the requested date.  This is deliberately based on the date projection,
 * rather than a fixed-point offset guess: it handles a midnight gap by
 * returning the first real instant of that date and a skipped date by
 * returning the first instant of the following real date.
 */
function firstInstantAtOrAfterDate(
  date: CalendarParts,
  formatter: Intl.DateTimeFormat,
): Date {
  const targetOrdinal = calendarPartsAsUtcMillis(date.year, date.month, date.day);
  let low = targetOrdinal - 2 * MILLIS_PER_DAY;
  let high = targetOrdinal + 2 * MILLIS_PER_DAY;
  let lowDays = 2;
  let highDays = 2;

  // IANA zones can have historical offsets outside today's usual range. Keep
  // expanding the bracket until it straddles the target date instead of
  // baking an offset assumption into this conversion.
  while (localDateOrdinal(low, formatter) >= targetOrdinal && lowDays < MAX_BOUNDARY_SEARCH_DAYS) {
    low -= MILLIS_PER_DAY;
    lowDays += 1;
  }
  while (localDateOrdinal(high, formatter) < targetOrdinal && highDays < MAX_BOUNDARY_SEARCH_DAYS) {
    high += MILLIS_PER_DAY;
    highDays += 1;
  }

  if (
    localDateOrdinal(low, formatter) >= targetOrdinal ||
    localDateOrdinal(high, formatter) < targetOrdinal
  ) {
    throw new Error("Could not resolve calendar date boundary");
  }

  // The local calendar date projection is ordered over a UTC interval. A
  // binary search gives millisecond precision at ordinary transitions while
  // also naturally collapsing a skipped date to the next real boundary.
  while (high - low > 1) {
    const middle = low + Math.floor((high - low) / 2);
    if (localDateOrdinal(middle, formatter) >= targetOrdinal) {
      high = middle;
    } else {
      low = middle;
    }
  }

  return new Date(high);
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

  const formatter = createDateFormatter(timeZone);
  return {
    from: firstInstantAtOrAfterDate(from, formatter).toISOString(),
    to: firstInstantAtOrAfterDate(
      parseCalendarDate(addCalendarDays(toDate, 1)),
      formatter,
    ).toISOString(),
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
  const parts = getZonedParts(timestamp, createDateFormatter(timeZone));
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
