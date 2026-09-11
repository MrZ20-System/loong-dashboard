import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import {
  calendarDays,
  monthStart,
  shiftMonth,
  todayValue,
} from "./date-utils";
import { filterMessages } from "./messages";

const weekdayAnchor = new Date("2021-08-01T12:00:00Z");

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
  const { locale, t, formatDate, formatNumber } = useI18n();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(() => monthStart(from ?? today));
  const [pendingFrom, setPendingFrom] = useState<string | null>(null);
  const activeFrom = pendingFrom ?? from;
  const activeTo = pendingFrom === null ? to : null;
  const selectionFrom = pendingFrom ?? (to === null ? from : null);
  const days = calendarDays(cursor, null, today);
  const localizedDate = (value: string) =>
    formatDate(`${value}T12:00:00Z`, {
      year: "numeric",
      month: "short",
      day: "numeric",
    }, "UTC");
  const weekdays = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(weekdayAnchor);
    date.setUTCDate(weekdayAnchor.getUTCDate() + index);
    return new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(date);
  });
  const monthHeading = formatDate(`${cursor.slice(0, 7)}-01T12:00:00Z`, {
    year: "numeric",
    month: "long",
  }, "UTC");

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

  const label = pendingFrom !== null
    ? t(filterMessages.chooseEndAfter, { date: localizedDate(pendingFrom) })
    : from !== null && to !== null
      ? t(filterMessages.between, { from: localizedDate(from), to: localizedDate(to) })
      : from !== null
        ? t(filterMessages.from, { date: localizedDate(from) })
        : t(filterMessages.allDates);
  const rawLabel = pendingFrom !== null
    ? pendingFrom
    : from !== null && to !== null
      ? `${from} – ${to}`
      : from ?? "";
  const accessibleLabel = rawLabel.length > 0 ? `${label} (${rawLabel})` : label;

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
        aria-label={t(filterMessages.dateRangeAria, { label: accessibleLabel, timeZone: calendarTimeZone })}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="date-day-filter__icon" aria-hidden="true">
          ◷
        </span>
        <span className="date-day-filter__copy">
          <small>{t(filterMessages.dateRangeTimezone, { timeZone: calendarTimeZone })}</small>
          <strong>{label}</strong>
        </span>
        <span aria-hidden="true">{open ? "⌃" : "⌄"}</span>
      </button>
      {open && (
        <div
          className="date-day-filter__panel"
          role="dialog"
          aria-label={t(filterMessages.selectDateRange)}
        >
          <header>
            <div className="date-day-filter__panel-heading">
              <strong>{monthHeading}</strong>
              <small>
                {selectionFrom === null ? t(filterMessages.chooseStartDate) : t(filterMessages.chooseEndDate)}
              </small>
            </div>
            <div className="date-day-filter__month-navigation">
              <button
                type="button"
                aria-label={t(filterMessages.previousMonth)}
                onClick={() => setCursor((current) => shiftMonth(current, -1))}
              >
                ‹
              </button>
              <button
                type="button"
                aria-label={t(filterMessages.nextMonth)}
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
                    {formatNumber(day.day)}
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
              {t(filterMessages.clear)}
            </button>
          </footer>
        </div>
      )}
    </div>
  );
}
