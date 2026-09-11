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
import { useI18n } from "../../i18n";
import { communityMessages } from "./messages";

function repositoryListPath(
  repositoryId: string,
  kind: "pulls" | "issues",
  from: string,
  to: string,
): string {
  const query = new URLSearchParams({ from, to, archive: "all" });
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
  const { t, formatNumber } = useI18n();
  return (
    <article className="activity-day-card">
      <strong>{formatNumber(count ?? 0)}</strong>
      <span>{label}</span>
      <Link to={to}>{t(communityMessages.openList)}</Link>
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
  const { t, formatNumber, formatDate } = useI18n();
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
      searchParams.get("from") !== from ||
      searchParams.get("to") !== to
    ) {
      const next = new URLSearchParams(searchParams);
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

  if (repositories.isPending) return <p role="status">{t(communityMessages.loadingRepositories)}</p>;
  if (repositories.isError)
    return <p role="alert">{t(communityMessages.unableLoadRepositories, { detail: repositories.error.message })}</p>;
  if (!repository)
    return (
      <section>
        <h2>{t(communityMessages.repositoryNotFound)}</h2>
        <p role="alert">{t(communityMessages.repositoryMissing)}</p>
        <Link to="/">{t(communityMessages.chooseAnotherRepository)}</Link>
      </section>
    );

  const pullRangeTotal = countInRange(pulls.data?.days, from, to);
  const issueRangeTotal = countInRange(issues.data?.days, from, to);
  const calendarTimeZone = pulls.data?.calendarTimeZone ?? issues.data?.calendarTimeZone;

  const selectRange = ({ from: nextFrom, to: nextTo }: DateRangeValue) => {
    const next = new URLSearchParams(searchParams);
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
          <h2 id="activity-heading">{t(communityMessages.activity)}</h2>
        </div>
        <nav className="repository-tabs" aria-label={t(communityMessages.repositorySections)}>
          <Link
            to={`/repositories/${encodeURIComponent(repository.id)}/pulls`}
          >
            {t(communityMessages.pullRequests)}
          </Link>
          <Link to={`/repositories/${encodeURIComponent(repository.id)}/issues`}>
            {t(communityMessages.issues)}
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
      <div className="activity-summary" aria-label={t(communityMessages.selectedDateRange)}>
        <DayCount
          label={t(communityMessages.pullRequestsUpdated)}
          count={pullRangeTotal}
          to={repositoryListPath(repository.id, "pulls", from, to)}
        />
        <DayCount
          label={t(communityMessages.issuesUpdated)}
          count={issueRangeTotal}
          to={repositoryListPath(repository.id, "issues", from, to)}
        />
      </div>
      {pulls.isPending || issues.isPending ? (
        <p role="status">{t(communityMessages.loadingActivityCounts)}</p>
      ) : pulls.isError || issues.isError ? (
        <p role="alert">
          {t(communityMessages.unableLoadActivity, {
            detail: (pulls.error ?? issues.error)?.message ?? t(communityMessages.unknownError),
          })}
        </p>
      ) : (
        <p role="status" className="activity-month-total">
          {t(communityMessages.activityMonthTotal, {
            pullCount: formatNumber(pullRangeTotal),
            issueCount: formatNumber(issueRangeTotal),
            from: formatDate(`${from}T12:00:00Z`, { year: "numeric", month: "short", day: "numeric" }, "UTC"),
            to: formatDate(`${to}T12:00:00Z`, { year: "numeric", month: "short", day: "numeric" }, "UTC"),
          })}
        </p>
      )}
    </section>
  );
}
