import { describe, expect, it } from "vitest";
import { nextOccurrence, validateCron } from "../src/cron.js";

describe("scheduler cron", () => {
  it("validates exactly five fields and delegates field validation", () => {
    expect(() => validateCron("*/15 9-17 * * 1-5")).not.toThrow();
    expect(() => validateCron("5,10,15 9 * * 1-5")).not.toThrow();
    expect(() => validateCron("0 0 * * * *")).toThrow(/5 fields/);
    expect(() => validateCron("0 0 * *")).toThrow(/5 fields/);
    expect(() => validateCron("61 0 * * *")).toThrow(/Invalid 5-field cron/);
    expect(() => validateCron("x 0 * * *")).toThrow(/only digits/);
    expect(() => validateCron("0 0 * * MON-FRI")).toThrow(/only digits/);
    expect(() => validateCron("0 0 * * ?")).toThrow(/only digits/);
    expect(() => validateCron("0 0 * * 1#2")).toThrow(/only digits/);
    expect(() => validateCron("0 0 L * *")).toThrow(/only digits/);
    expect(() => validateCron("0 0 W * *")).toThrow(/only digits/);
  });

  it("computes a timezone-aware daily occurrence", () => {
    const next = nextOccurrence(
      "30 9 * * *",
      "Asia/Shanghai",
      new Date("2026-09-03T01:00:00.000Z"),
    );
    expect(next.toISOString()).toBe("2026-09-03T01:30:00.000Z");
  });

  it("supports lists, ranges, and steps", () => {
    const next = nextOccurrence(
      "5-15/5 9,10 * * 1-5",
      "UTC",
      new Date("2026-09-07T08:00:00.000Z"),
    );
    expect(next.toISOString()).toBe("2026-09-07T09:05:00.000Z");
  });

  it("accepts Sunday 7 as Sunday", () => {
    const next = nextOccurrence(
      "0 9 * * 7",
      "UTC",
      new Date("2026-09-05T10:00:00.000Z"),
    );
    expect(next.toISOString()).toBe("2026-09-06T09:00:00.000Z");
  });

  it("uses Vixie/POSIX OR semantics for restricted DOM and DOW", () => {
    const next = nextOccurrence(
      "0 9 10 * 1",
      "UTC",
      new Date("2026-09-01T00:00:00.000Z"),
    );
    expect(next.toISOString()).toBe("2026-09-07T09:00:00.000Z");
  });

  it("treats */1 as a wildcard in the DOM/DOW rule", () => {
    const next = nextOccurrence(
      "0 9 10 * */1",
      "UTC",
      new Date("2026-09-01T00:00:00.000Z"),
    );
    expect(next.toISOString()).toBe("2026-09-10T09:00:00.000Z");
  });

  it("is strictly after the supplied instant", () => {
    const exact = nextOccurrence(
      "0 9 * * *",
      "UTC",
      new Date("2026-09-03T09:00:00.000Z"),
    );
    const fractional = nextOccurrence(
      "0 9 * * *",
      "UTC",
      new Date("2026-09-03T08:59:59.999Z"),
    );
    expect(exact.toISOString()).toBe("2026-09-04T09:00:00.000Z");
    expect(fractional.toISOString()).toBe("2026-09-03T09:00:00.000Z");
    expect(exact.getTime()).toBeGreaterThan(new Date("2026-09-03T09:00:00.000Z").getTime());
  });

  it("follows cron-parser's DST spring-forward gap semantics", () => {
    const next = nextOccurrence(
      "30 2 * * *",
      "America/New_York",
      new Date("2026-03-08T06:59:00.000Z"),
    );
    // cron-parser lands the skipped 02:30 wall time at 03:30 EDT.
    expect(next.toISOString()).toBe("2026-03-08T07:30:00.000Z");
  });

  it("follows cron-parser's DST fall-back repeat semantics", () => {
    const first = nextOccurrence(
      "30 1 * * *",
      "America/New_York",
      new Date("2026-11-01T05:00:00.000Z"),
    );
    const afterFirst = nextOccurrence(
      "30 1 * * *",
      "America/New_York",
      first,
    );
    expect(first.toISOString()).toBe("2026-11-01T05:30:00.000Z");
    // The selected library does not return the repeated wall time twice.
    expect(afterFirst.toISOString()).toBe("2026-11-02T06:30:00.000Z");
  });

  it("rejects an invalid IANA timezone clearly", () => {
    expect(() =>
      nextOccurrence("0 0 * * *", "Not/AZone", new Date("2026-09-01T00:00:00.000Z")),
    ).toThrow(/Invalid IANA timezone/);
  });

  it("rejects invalid five-field input before calculation", () => {
    expect(() =>
      nextOccurrence("0 0 * * * *", "UTC", new Date("2026-09-01T00:00:00.000Z")),
    ).toThrow(/5 fields/);
  });
});
