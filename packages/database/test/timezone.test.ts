import { describe, expect, it } from "vitest";

import {
  calendarDateRangeToUtc,
  calendarDateToUtc,
  utcDateToCalendarDate,
} from "../src/index.js";

describe("IANA calendar date boundaries", () => {
  it("starts after Havana's midnight gap", () => {
    expect(calendarDateToUtc("2000-04-02", "America/Havana")).toEqual({
      from: "2000-04-02T05:00:00.000Z",
      to: "2000-04-03T04:00:00.000Z",
    });
  });

  it("maps Apia's skipped date to an empty interval", () => {
    const skipped = calendarDateToUtc("2011-12-30", "Pacific/Apia");
    expect(skipped).toEqual({
      from: "2011-12-30T10:00:00.000Z",
      to: "2011-12-30T10:00:00.000Z",
    });

    expect(calendarDateToUtc("2011-12-29", "Pacific/Apia")).toEqual({
      from: "2011-12-29T10:00:00.000Z",
      to: "2011-12-30T10:00:00.000Z",
    });
    expect(calendarDateToUtc("2011-12-31", "Pacific/Apia")).toEqual({
      from: "2011-12-30T10:00:00.000Z",
      to: "2011-12-31T10:00:00.000Z",
    });
    expect(calendarDateRangeToUtc("2011-12-29", "2011-12-31", "Pacific/Apia")).toEqual({
      from: "2011-12-29T10:00:00.000Z",
      to: "2011-12-31T10:00:00.000Z",
    });
  });

  it("round-trips real UTC instants using the requested calendar date", () => {
    expect(utcDateToCalendarDate("2000-04-02T05:00:00.000Z", "America/Havana")).toBe(
      "2000-04-02",
    );
    expect(utcDateToCalendarDate("2011-12-30T10:00:00.000Z", "Pacific/Apia")).toBe(
      "2011-12-31",
    );
  });
});
