import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useRepositories } from "../../app/hooks";
import { fetchActivityDays } from "../../activity-client";
import {
  DateDayFilter,
  type DateRangeValue,
} from "../../components/filters/DateDayFilter";
import { monthEnd, monthStart, todayValue } from "../../components/filters/date-utils";
import { readDateRange } from "../../metadata-client";

function repositoryListPath(
  repositoryId: string,
  kind: "pulls" | "issues",
  from: string,
  to: string,
): string {
  const query = new URLSearchParams({ from, to });
  return `/repositories/${encodeURIComponent(repositoryId)}/${kind}?${query.toString()}`;
}

function DayCount({
  label,
  count,
  to,
}: {
  label: string;
  count: number | undefined;
  to: string;
}) {
  return (
    <article className="activity-day-card">
      <strong>{count ?? 0}</strong>
      <span>{label}</span>
      <Link to={to}>Open list</Link>
    </article>
  );
}

function countInRange(
  days: Array<{ date: string; count: number }> | undefined,
  from: string,
  to: string,
): number {
  return (
    days?.reduce(
      (total, day) =>
        day.date >= from && day.date <= to ? total + day.count : total,
      0,
    ) ?? 0
  );
}

export function RepositoryActivityPage() {
  const { repositoryId = "" } = useParams();
  const repositories = useRepositories();
  const [searchParams, setSearchParams] = useSearchParams();
  const today = todayValue();
  const defaultRange = { from: monthStart(today), to: monthEnd(today) };
  const selectedRange = readDateRange(searchParams, defaultRange);
  const from = selectedRange.from ?? defaultRange.from;
  const to = selectedRange.to ?? defaultRange.to;
  useEffect(() => {
    if (
      searchParams.get("date") !== null ||
      searchParams.get("from") !== from ||
      searchParams.get("to") !== to
    ) {
      const next = new URLSearchParams(searchParams);
      next.delete("date");
      next.set("from", from);
      next.set("to", to);
      setSearchParams(next, { replace: true });
    }
  }, [from, searchParams, setSearchParams, to]);
  const repository = repositories.data?.items.find((item) => item.id === repositoryId);

  const pulls = useQuery({
    queryKey: ["activity-days", repositoryId, "pulls", from, to],
    enabled: repositoryId.length > 0,
    queryFn: () => fetchActivityDays(repositoryId, "pulls", from, to),
  });
  const issues = useQuery({
    queryKey: ["activity-days", repositoryId, "issues", from, to],
    enabled: repositoryId.length > 0,
    queryFn: () => fetchActivityDays(repositoryId, "issues", from, to),
  });

  if (repositories.isPending) return <p role="status">Loading repositories…</p>;
  if (repositories.isError)
    return <p role="alert">Unable to load repositories: {repositories.error.message}</p>;
  if (!repository)
    return (
      <section>
        <h2>Repository not found</h2>
        <p role="alert">This repository is missing or disabled.</p>
        <Link to="/">Choose another repository</Link>
      </section>
    );

  const pullRangeTotal = countInRange(pulls.data?.days, from, to);
  const issueRangeTotal = countInRange(issues.data?.days, from, to);
  const calendarTimeZone = pulls.data?.calendarTimeZone ?? issues.data?.calendarTimeZone;

  const selectRange = ({ from: nextFrom, to: nextTo }: DateRangeValue) => {
    const next = new URLSearchParams(searchParams);
    next.delete("date");
    if (nextFrom) next.set("from", nextFrom);
    else next.delete("from");
    if (nextTo) next.set("to", nextTo);
    else next.delete("to");
    setSearchParams(next);
  };

  return (
    <section className="activity-page" aria-labelledby="activity-heading">
      <header className="page-heading activity-page__heading">
        <div>
          <p className="eyebrow">
            {repository.githubOwner}/{repository.githubName}
          </p>
          <h2 id="activity-heading">Repository activity</h2>
        </div>
        <nav className="repository-tabs" aria-label="Repository sections">
          <Link
            to={`/repositories/${encodeURIComponent(repository.id)}/pulls`}
          >
            Pull requests
          </Link>
          <Link to={`/repositories/${encodeURIComponent(repository.id)}/issues`}>
            Issues
          </Link>
        </nav>
      </header>
      <div className="activity-toolbar">
        <DateDayFilter
          from={from}
          to={to}
          onChange={selectRange}
          calendarTimeZone={calendarTimeZone}
          today={today}
        />
      </div>
      <div className="activity-summary" aria-label="Selected date range summary">
        <DayCount
          label="Pull requests updated"
          count={pullRangeTotal}
          to={repositoryListPath(repository.id, "pulls", from, to)}
        />
        <DayCount
          label="Issues updated"
          count={issueRangeTotal}
          to={repositoryListPath(repository.id, "issues", from, to)}
        />
      </div>
      {pulls.isPending || issues.isPending ? (
        <p role="status">Loading activity counts…</p>
      ) : pulls.isError || issues.isError ? (
        <p role="alert">
          Unable to load activity:{" "}
          {(pulls.error ?? issues.error)?.message ?? "unknown error"}
        </p>
      ) : (
        <p role="status" className="activity-month-total">
          {pullRangeTotal} pull requests and {issueRangeTotal} issues updated from {from} to {to}
        </p>
      )}
    </section>
  );
}
