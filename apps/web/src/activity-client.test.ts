import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchActivityDays } from "./activity-client";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("activity-days client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests pull activity days for a bounded calendar range", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        days: [
          { date: "2026-09-03", count: 2 },
          { date: "2026-09-04", count: 0 },
        ],
        calendarTimeZone: "Asia/Shanghai",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchActivityDays("repo", "pulls", "2026-09-01", "2026-09-30");

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "/api/repositories/repo/pulls/activity-days?from=2026-09-01&to=2026-09-30",
    );
    expect(result.days).toEqual([
      { date: "2026-09-03", count: 2 },
      { date: "2026-09-04", count: 0 },
    ]);
  });
});
