import { describe, expect, it } from "vitest";
import {
  calendarDays,
  monthEnd,
  monthStart,
  shiftDay,
  shiftMonth,
} from "./date-utils";

describe("calendar date utilities", () => {
  it("shifts a single day and month while preserving ISO date format", () => {
    expect(shiftDay("2026-09-03", -1)).toBe("2026-09-02");
    expect(shiftMonth("2026-09-03", 1)).toBe("2026-10-01");
    expect(shiftMonth("2026-01-15", -1)).toBe("2025-12-01");
  });

  it("returns month bounds and a 42-day UTC calendar grid", () => {
    expect(monthStart("2026-09-15")).toBe("2026-09-01");
    expect(monthEnd("2026-09-15")).toBe("2026-09-30");
    const days = calendarDays("2026-09-01", "2026-09-03", "2026-09-07");
    expect(days).toHaveLength(42);
    const third = days.find((day) => day.value === "2026-09-03");
    expect(third?.selected).toBe(true);
    const today = days.find((day) => day.value === "2026-09-07");
    expect(today?.today).toBe(true);
  });
});
