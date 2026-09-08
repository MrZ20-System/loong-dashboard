import { useEffect, useRef, useState } from "react";
import {
  calendarDays,
  monthLabel,
  monthStart,
  shiftMonth,
  todayValue,
} from "./date-utils";

const weekdays = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

export type DateRangeValue = {
  from: string | null;
  to: string | null;
};

export function DateDayFilter({
  from,
  to,
  onChange,
  calendarTimeZone = "Asia/Shanghai",
  today = todayValue(),
}: {
  from: string | null;
  to: string | null;
  onChange: (value: DateRangeValue) => void;
  calendarTimeZone?: string;
  today?: string;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(() => monthStart(from ?? today));
  const [pendingFrom, setPendingFrom] = useState<string | null>(null);
  const activeFrom = pendingFrom ?? from;
  const activeTo = pendingFrom === null ? to : null;
  const selectionFrom = pendingFrom ?? (to === null ? from : null);
  const days = calendarDays(cursor, null, today);

  useEffect(() => {
    if (!open) return;
    setCursor(monthStart(from ?? today));
    setPendingFrom(from !== null && to === null ? from : null);
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [from, open, today, to]);

  const label =
    pendingFrom !== null
      ? `Choose end after ${pendingFrom}`
      : from !== null && to !== null
        ? `${from} – ${to}`
        : from !== null
          ? `From ${from}`
          : "All dates";

  const selectDay = (value: string) => {
    if (selectionFrom === null) {
      setPendingFrom(value);
      return;
    }
    onChange(
      selectionFrom <= value
        ? { from: selectionFrom, to: value }
        : { from: value, to: selectionFrom },
    );
    setPendingFrom(null);
    setOpen(false);
  };

  const clear = () => {
    setPendingFrom(null);
    onChange({ from: null, to: null });
    setOpen(false);
  };

  return (
    <div className="date-day-filter" ref={rootRef}>
      <button
        type="button"
        className="date-day-filter__trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Date range: ${label}. Timezone: ${calendarTimeZone}`}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="date-day-filter__icon" aria-hidden="true">
          ◷
        </span>
        <span className="date-day-filter__copy">
          <small>Date range · {calendarTimeZone}</small>
          <strong>{label}</strong>
        </span>
        <span aria-hidden="true">{open ? "⌃" : "⌄"}</span>
      </button>
      {open && (
        <div
          className="date-day-filter__panel"
          role="dialog"
          aria-label="Select date range"
        >
          <header>
            <div className="date-day-filter__panel-heading">
              <strong>{monthLabel(cursor)}</strong>
              <small>
                {selectionFrom === null ? "Choose a start date" : "Choose an end date"}
              </small>
            </div>
            <div className="date-day-filter__month-navigation">
              <button
                type="button"
                aria-label="Previous month"
                onClick={() => setCursor((current) => shiftMonth(current, -1))}
              >
                ‹
              </button>
              <button
                type="button"
                aria-label="Next month"
                onClick={() => setCursor((current) => shiftMonth(current, 1))}
              >
                ›
              </button>
            </div>
          </header>
          <div className="date-day-filter__weekdays" aria-hidden="true">
            {weekdays.map((weekday) => (
              <span key={weekday}>{weekday}</span>
            ))}
          </div>
          <div className="date-day-filter__days">
            {days.map((day) => (
              (() => {
                const isStart = day.value === activeFrom;
                const isEnd = day.value === activeTo;
                const inRange =
                  activeFrom !== null &&
                  activeTo !== null &&
                  day.value >= activeFrom &&
                  day.value <= activeTo;
                return (
                  <button
                    key={day.value}
                    type="button"
                    className={[
                      !day.currentMonth ? "is-outside" : "",
                      day.today ? "is-today" : "",
                      inRange ? "is-in-range" : "",
                      isStart ? "is-range-start" : "",
                      isEnd ? "is-range-end" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    aria-label={day.value}
                    aria-pressed={isStart || isEnd}
                    aria-current={day.today ? "date" : undefined}
                    onClick={() => selectDay(day.value)}
                  >
                    {day.day}
                  </button>
                );
              })()
            ))}
          </div>
          <footer>
            <button
              type="button"
              disabled={from === null && to === null && pendingFrom === null}
              onClick={clear}
            >
              Clear
            </button>
          </footer>
        </div>
      )}
    </div>
  );
}
