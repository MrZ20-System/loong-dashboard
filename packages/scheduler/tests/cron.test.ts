import { describe, expect, it } from "vitest";
import { nextOccurrence, parseCron, validateCron } from "../src/cron.js";

describe("scheduler cron", () => {
  it("parses a five-field expression into its value sets", () => {
    const schedule = parseCron("*/15 9-17 * * 1-5");
    expect(schedule.minutes).toContain(0);
    expect(schedule.minutes).toContain(45);
    expect(schedule.hours).toContain(17);
    expect(schedule.hours).not.toContain(18);
    expect(schedule.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
    expect(schedule.dayOfMonthWildcard).toBe(true);
    expect(schedule.dayOfWeekWildcard).toBe(false);
  });

  it("normalizes Sunday 7 to 0", () => {
    expect(parseCron("0 0 * * 7").daysOfWeek).toEqual([0]);
  });

  it("rejects malformed or out-of-range fields", () => {
    expect(() => validateCron("0 0 * *")).toThrow();
    expect(() => validateCron("61 0 * * *")).toThrow();
    expect(() => validateCron("x 0 * * *")).toThrow();
  });

  it("computes the next daily occurrence after the from time", () => {
    const next = nextOccurrence("30 9 * * *", "Asia/Shanghai", new Date("2026-09-03T01:00:00.000Z"));
    expect(next.toISOString()).toBe("2026-09-03T01:30:00.000Z");
  });

  it("computes the next week day after a weekend", () => {
    // 2026-09-05 is a Saturday in Asia/Shanghai? Use a fixed instant.
    const from = new Date("2026-09-04T02:00:00.000Z"); // Friday 10:00 Shanghai
    const next = nextOccurrence("0 9 * * 1", "Asia/Shanghai", from);
    expect(next.toISOString()).toBe("2026-09-07T01:00:00.000Z"); // Monday 09:00 +08
  });

  it("uses cron OR semantics when both day fields are restricted", () => {
    const from = new Date("2026-09-01T00:00:00.000Z"); // Tuesday
    const next = nextOccurrence("0 9 10 * 1", "UTC", from);
    expect(next.toISOString()).toBe("2026-09-07T09:00:00.000Z"); // Monday wins before the 10th
  });

  it("finds a leap-day occurrence beyond the former two-year horizon", () => {
    const from = new Date("2025-03-01T00:00:00.000Z");
    const next = nextOccurrence("0 9 29 2 *", "UTC", from);
    expect(next.toISOString()).toBe("2028-02-29T09:00:00.000Z");
  });

  it("does not skip midnight at a selected month boundary", () => {
    const from = new Date("2026-01-31T23:31:00.000Z");
    const next = nextOccurrence("0 0 1 2 *", "UTC", from);
    expect(next.toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });

  it("skips a nonexistent local time across a DST spring-forward gap", () => {
    const from = new Date("2026-03-08T06:59:00.000Z"); // 01:59 in New York
    const next = nextOccurrence("30 2 * * *", "America/New_York", from);
    expect(next.toISOString()).toBe("2026-03-09T06:30:00.000Z");
  });
});
