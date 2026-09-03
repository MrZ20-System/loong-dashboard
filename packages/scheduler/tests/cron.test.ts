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
});
