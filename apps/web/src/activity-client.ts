import {
  activityDaysResponseSchema,
  type ActivityDaysResponse,
} from "@loongboard/contracts";
import { request } from "./metadata-client";

export function fetchActivityDays(
  repositoryId: string,
  kind: "pulls" | "issues",
  from: string,
  to: string,
): Promise<ActivityDaysResponse> {
  const query = new URLSearchParams({ from, to });
  const url = `/api/repositories/${encodeURIComponent(repositoryId)}/${kind}/activity-days?${query.toString()}`;
  return request(url, activityDaysResponseSchema);
}

export function activityDaysByDate(days: ActivityDaysResponse["days"]) {
  return new Map(days.map((day) => [day.date, day.count]));
}
