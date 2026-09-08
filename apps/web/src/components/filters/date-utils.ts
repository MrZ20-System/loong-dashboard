export interface CalendarDay {
  value: string;
  day: number;
  currentMonth: boolean;
  today: boolean;
  selected: boolean;
}

function parse(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

export function formatDate(value: Date): string {
  return [
    value.getUTCFullYear(),
    String(value.getUTCMonth() + 1).padStart(2, "0"),
    String(value.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

export function todayValue(): string {
  return formatDate(new Date());
}

export function shiftDay(value: string, offset: number): string {
  const date = parse(value);
  date.setUTCDate(date.getUTCDate() + offset);
  return formatDate(date);
}

export function shiftMonth(value: string, offset: number): string {
  const date = parse(value);
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + offset, 1);
  return formatDate(date);
}

export function monthLabel(value: string): string {
  const date = parse(value);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function monthStart(value: string): string {
  const date = parse(value);
  date.setUTCDate(1);
  return formatDate(date);
}

export function monthEnd(value: string): string {
  const date = parse(value);
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + 1, 0);
  return formatDate(date);
}

export function calendarDays(
  cursor: string,
  selected: string | null,
  today = todayValue(),
): CalendarDay[] {
  const first = parse(cursor);
  const gridStart = new Date(first);
  gridStart.setUTCDate(1 - first.getUTCDay());
  const days: CalendarDay[] = [];
  for (let index = 0; index < 42; index += 1) {
    const date = new Date(gridStart);
    date.setUTCDate(gridStart.getUTCDate() + index);
    const value = formatDate(date);
    days.push({
      value,
      day: date.getUTCDate(),
      currentMonth: date.getUTCMonth() === first.getUTCMonth(),
      today: value === today,
      selected: value === selected,
    });
  }
  return days;
}
