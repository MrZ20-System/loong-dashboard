import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DateDayFilter } from "./DateDayFilter";

describe("DateDayFilter", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("selects a date range and keeps the timezone inside the control", () => {
    const onChange = vi.fn();
    render(
      <DateDayFilter
        from="2026-09-03"
        to="2026-09-05"
        onChange={onChange}
        calendarTimeZone="Asia/Shanghai"
        today="2026-09-07"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /2026-09-03/ }));
    expect(
      screen.getByRole("button", { name: /Timezone: Asia\/Shanghai/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Today" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Yesterday" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "2026-09-10" }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "2026-09-12" }));
    expect(onChange).toHaveBeenCalledWith({ from: "2026-09-10", to: "2026-09-12" });
  });

  it("can clear an active date range", () => {
    const onChange = vi.fn();
    render(
      <DateDayFilter
        from="2026-09-03"
        to="2026-09-05"
        onChange={onChange}
        today="2026-09-07"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /2026-09-03/ }));
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onChange).toHaveBeenCalledWith({ from: null, to: null });
  });

  it("highlights a completed range after reopening and isolates a new start", () => {
    const onChange = vi.fn();
    render(
      <DateDayFilter
        from="2026-09-03"
        to="2026-09-05"
        onChange={onChange}
        today="2026-09-07"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /2026-09-03/ }));
    expect(screen.getByRole("button", { name: "2026-09-03" })).toHaveClass(
      "is-range-start",
    );
    expect(screen.getByRole("button", { name: "2026-09-04" })).toHaveClass(
      "is-in-range",
    );
    expect(screen.getByRole("button", { name: "2026-09-05" })).toHaveClass(
      "is-range-end",
    );

    fireEvent.click(screen.getByRole("button", { name: "2026-09-10" }));
    expect(screen.getByRole("button", { name: "2026-09-10" })).toHaveClass(
      "is-range-start",
    );
    expect(screen.getByRole("button", { name: "2026-09-04" })).not.toHaveClass(
      "is-in-range",
    );
    expect(screen.getByRole("button", { name: "2026-09-12" })).not.toHaveClass(
      "is-range-end",
    );
    expect(onChange).not.toHaveBeenCalled();
  });
});
