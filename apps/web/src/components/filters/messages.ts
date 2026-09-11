import { message } from "../../i18n";

export const filterMessages = {
  allDates: message("All dates", "全部日期"),
  from: message("From {date}", "从 {date} 开始"),
  between: message("{from} – {to}", "{from} – {to}"),
  chooseEndAfter: message("Choose end after {date}", "选择 {date} 之后的结束日期"),
  dateRange: message("Date range", "日期范围"),
  dateRangeTimezone: message("Date range · {timeZone}", "日期范围 · {timeZone}"),
  dateRangeAria: message(
    "Date range: {label}. Timezone: {timeZone}",
    "日期范围：{label}。时区：{timeZone}",
  ),
  selectDateRange: message("Select date range", "选择日期范围"),
  chooseStartDate: message("Choose a start date", "选择开始日期"),
  chooseEndDate: message("Choose an end date", "选择结束日期"),
  previousMonth: message("Previous month", "上个月"),
  nextMonth: message("Next month", "下个月"),
  clear: message("Clear", "清除"),
  selected: message("{count} selected", "已选择 {count} 项"),
  noSelection: message("No selection", "未选择"),
  options: message("{label} options", "{label}选项"),
};
