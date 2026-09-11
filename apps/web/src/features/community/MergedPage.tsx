import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { MergedPullRequestListItem } from "@loongboard/contracts";
import { useRepositories } from "../../app/hooks";
import { DomainChips } from "../../components/domain/DomainChips";
import { DomainFilter } from "../../components/domain/DomainFilter";
import { metadataMessages } from "../../components/metadata/messages";
import { Pagination } from "../../components/metadata/Pagination";
import { MetadataSearchField } from "../../components/metadata/MetadataList";
import { Codicon } from "../../components/pr/codicon";
import { fetchMergedPullRequests } from "../../metadata-client";
import { useI18n } from "../../i18n";
import { communityMessages } from "./messages";

const PAGE_SIZE = 100;
type PagedMerged = {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  calendarTimeZone: string;
};

export function mergedCalendarDay(value: string, timeZone: string): string {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return value;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(timestamp);
    const year = parts.find((part) => part.type === "year")?.value;
    const month = parts.find((part) => part.type === "month")?.value;
    const day = parts.find((part) => part.type === "day")?.value;
    if (year && month && day) return `${year}-${month}-${day}`;
  } catch {
    // If the browser cannot construct the formatter, use the timestamp's
    // calendar date so the row remains renderable.
  }
  return value;
}

export function formatMergedDay(
  day: string,
  formatDate: (
    value: string,
    options?: Intl.DateTimeFormatOptions,
    timeZone?: string,
  ) => string,
  timeZone: string,
): string {
  // Invalid provider values are data, not dates to repair. Preserve the raw
  // string rather than constructing a different invalid value.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
  return formatDate(
    `${day}T12:00:00Z`,
    { month: "short", day: "numeric", year: "numeric" },
    timeZone,
  );
}

function MergedRow({ item, timeZone }: { item: MergedPullRequestListItem; timeZone: string }) {
  const { t, formatTime, formatNumber } = useI18n();
  const navigate = useNavigate();
  const detailPath = `/repositories/${encodeURIComponent(item.repositoryId)}/pulls/${item.number}`;
  const openDetail = () => navigate(detailPath);
  return <li className="feed-row feed-row--interactive merged-row" role="link" tabIndex={0} aria-label={t(metadataMessages.itemAria, { kind: t(metadataMessages.pullRequest), number: item.number, title: item.title })} onClick={openDetail} onKeyDown={(event) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openDetail(); }
  }}>
    <div className="feed-row__rail"><a className="feed-row__number" href={item.url} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>#{item.number}</a><Codicon name="git-merge" className="merged-row__icon" label={t(communityMessages.merged)} /></div>
    <div className="feed-row__content"><div className="feed-row__title-line"><h3 className="feed-row__title">{item.title}</h3><DomainChips domains={item.domains} /></div><p className="feed-row__meta"><span>{item.authorLogin ?? t(metadataMessages.unknown)}</span><span aria-hidden="true">·</span><span>{t(metadataMessages.mergedAt, { value: formatTime(item.mergedAt, { hour: "2-digit", minute: "2-digit" }, timeZone) })}</span><span aria-hidden="true">·</span><span>{t(metadataMessages.pullStats, { additions: formatNumber(item.additions), deletions: formatNumber(item.deletions), files: formatNumber(item.changedFilesCount) })}</span></p></div>
  </li>;
}

export function MergedPage() {
  const { t, formatDate, formatNumber } = useI18n();
  const { repositoryId = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const search = searchParams.get("search") ?? "";
  const domains = searchParams.getAll("domain");
  const rawPage = Number(searchParams.get("page"));
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const repositories = useRepositories();
  const repository = repositories.data?.items.find((item) => item.id === repositoryId);
  const query = useQuery({
    queryKey: ["merged", repositoryId, search, domains.join(","), page],
    enabled: repositoryId.length > 0,
    queryFn: ({ signal }) => fetchMergedPullRequests(repositoryId, { search, domains, page, limit: PAGE_SIZE }, signal),
    placeholderData: keepPreviousData,
  });
  const pageData = query.data as (typeof query.data & Partial<PagedMerged>) | undefined;
  const timeZone = pageData?.calendarTimeZone ?? "Asia/Shanghai";
  const items = query.data?.items ?? [];
  const totalCount = pageData?.totalCount ?? items.length;
  const totalPages = pageData?.totalPages === undefined ? Math.max(1, Math.ceil(totalCount / PAGE_SIZE)) : Math.max(1, pageData.totalPages);
  const pageSize = pageData?.pageSize ?? PAGE_SIZE;

  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    let changed = false;
    if (next.get("page") !== String(page)) {
      next.set("page", String(page));
      changed = true;
    }
    if (changed) setSearchParams(next, { replace: true });
  }, [page, searchParams, setSearchParams]);

  useEffect(() => {
    if (pageData?.totalPages === undefined || page <= Math.max(1, pageData.totalPages)) return;
    const next = new URLSearchParams(searchParams);
    next.set("page", String(Math.max(1, pageData.totalPages)));
    setSearchParams(next, { replace: true });
  }, [page, pageData?.totalPages, searchParams, setSearchParams]);

  const updateUrl = (mutate: (next: URLSearchParams) => void) => {
    const next = new URLSearchParams(searchParams);
    mutate(next);
    next.set("page", "1");
    setSearchParams(next);
  };
  const updateSearch = (value: string) => updateUrl((next) => { if (value.trim()) next.set("search", value); else next.delete("search"); });
  const updateDomains = (values: string[]) => updateUrl((next) => { next.delete("domain"); for (const value of values) next.append("domain", value); });

  if (repositories.isPending) return <p role="status">{t(communityMessages.loadingRepositories)}</p>;
  if (repositories.isError) return <p role="alert">{t(communityMessages.unableLoadRepositories, { detail: repositories.error.message })}</p>;
  if (!repository) return <section><h2>{t(communityMessages.repositoryNotFound)}</h2><p role="alert">{t(communityMessages.repositoryMissing)}</p></section>;

  const groups = new Map<string, MergedPullRequestListItem[]>();
  for (const item of items) {
    const day = mergedCalendarDay(item.mergedAt, timeZone);
    const group = groups.get(day);
    if (group) group.push(item); else groups.set(day, [item]);
  }

  return <section className="metadata-page merged-page" aria-labelledby="merged-heading">
    <div className="metadata-page__heading page-heading"><div><p className="eyebrow">{t(communityMessages.repositoryTimeline)}</p><h2 id="merged-heading">{t(communityMessages.merged)}</h2><p className="settings-muted">{t(communityMessages.actualMergeTime, { timeZone })}</p></div></div>
    <div className="metadata-panel">
      <div className="metadata-toolbar"><div className="filters metadata-filters"><MetadataSearchField kind="pulls" value={search} onChange={updateSearch} /></div></div>
      <DomainFilter repositoryId={repository.id} selected={domains} onChange={updateDomains} />
      {query.isPending && <p role="status">{t(communityMessages.loadingMerged)}</p>}
      {query.isError && <p role="alert">{t(communityMessages.unableLoadMerged, { detail: query.error instanceof Error ? query.error.message : t(communityMessages.unknownError) })}</p>}
      {!query.isPending && !query.isError && items.length === 0 && <p role="status">{t(communityMessages.noMergedMatch)}</p>}
      {!query.isPending && !query.isError && items.length > 0 && <div className="merged-timeline" aria-label={t(communityMessages.mergedTimeline)}>{[...groups.entries()].map(([day, group]) => <section className="merged-day-group" key={day} aria-labelledby={`merged-day-${day}`}><header className="merged-day-group__header"><span className="merged-day-group__node" aria-hidden="true"><Codicon name="git-merge" /></span><h3 id={`merged-day-${day}`}>{t(communityMessages.mergedOn, { date: formatMergedDay(day, formatDate, timeZone) })}</h3><span className="merged-day-group__count">{group.length === 1 ? t(communityMessages.pullRequestCount, { count: formatNumber(group.length) }) : t(communityMessages.pullRequestsCount, { count: formatNumber(group.length) })}</span></header><ul className="feed-list merged-day-group__list">{group.map((item) => <MergedRow item={item} timeZone={timeZone} key={`${item.repositoryId}-${item.number}`} />)}</ul></section>)}</div>}
      {!query.isError && (items.length > 0 || totalCount > 0) && <Pagination page={page} pageSize={pageSize} totalCount={totalCount} totalPages={totalPages} onPageChange={(nextPage) => { const next = new URLSearchParams(searchParams); next.set("page", String(nextPage)); setSearchParams(next); }} disabled={query.isFetching} label={communityMessages.mergedPagination} />}
      {query.isFetching && !query.isPending && <p role="status">{t(communityMessages.refreshing)}</p>}
    </div>
  </section>;
}
