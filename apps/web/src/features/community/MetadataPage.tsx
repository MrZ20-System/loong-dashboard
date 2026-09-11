import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useDomains, useRepositories } from "../../app/hooks";
import { DomainFilter } from "../../components/domain/DomainFilter";
import { DateDayFilter, type DateRangeValue } from "../../components/filters/DateDayFilter";
import { FilterDropdown } from "../../components/filters/FilterDropdown";
import { MetadataFeed, MetadataSearchField } from "../../components/metadata/MetadataList";
import { Pagination } from "../../components/metadata/Pagination";
import { buildListUrl, fetchList, readMetadataFilters } from "../../metadata-client";

export const pullStatuses = ["draft", "open", "closed", "merged"] as const;
export const issueStatuses = ["open", "closed"] as const;
const PAGE_SIZE = 100;
type PullRequestView = "updated" | "number";

type PagedMetadata = {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  calendarTimeZone: string;
};

function ReclassificationHint({ repositoryId }: { repositoryId: string }) {
  const domains = useDomains(repositoryId);
  if (!domains.data?.reclassification.running) return null;
  return <p role="status" className="reclassify-hint">重新分类中…</p>;
}

export function FilterBar({ kind, from, to, calendarTimeZone, status, search, onDateRange, onStatus, onSearch }: {
  kind: "pulls" | "issues";
  from: string | null;
  to: string | null;
  calendarTimeZone?: string;
  status: string | null;
  search: string;
  onDateRange: (value: DateRangeValue) => void;
  onStatus: (value: string) => void;
  onSearch: (value: string) => void;
}) {
  const statuses = kind === "pulls" ? pullStatuses : issueStatuses;
  return <form className="filters metadata-filters" aria-label="Metadata filters" onSubmit={(event) => event.preventDefault()}>
    <DateDayFilter from={from} to={to} calendarTimeZone={calendarTimeZone} onChange={onDateRange} />
    <MetadataSearchField kind={kind} value={search} onChange={onSearch} />
    <FilterDropdown label="Status" emptyLabel="All statuses" options={statuses.map((value) => ({ value, label: value }))} selected={status ? [status] : []} onChange={(values) => onStatus(values[0] ?? "")} />
  </form>;
}

function readView(value: string | null): PullRequestView {
  return value === "number" ? value : "updated";
}

function readPage(value: string | null): number {
  const page = Number(value);
  return Number.isInteger(page) && page > 0 ? page : 1;
}

export function MetadataPage({ kind }: { kind: "pulls" | "issues" }) {
  const { repositoryId = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = readMetadataFilters(kind, searchParams);
  const { from, to, status, search, domains } = filters;
  const view = kind === "pulls" ? readView(searchParams.get("view")) : "updated";
  const [issuePage, setIssuePage] = useState(1);
  const page = kind === "pulls" ? readPage(searchParams.get("page")) : issuePage;
  const rawPage = searchParams.get("page");
  const rawView = searchParams.get("view");
  const rawDate = searchParams.get("date");
  const rawFrom = searchParams.get("from");
  const rawTo = searchParams.get("to");
  const rawStatus = searchParams.get("status");
  const rawSearch = searchParams.get("search") ?? "";
  const rawDomains = kind === "pulls" ? searchParams.getAll("domain") : [];
  const filterKey = `${from ?? ""}:${to ?? ""}:${status ?? ""}:${search}:${domains.join(",")}`;
  const [issueCursors, setIssueCursors] = useState<Record<number, string | null>>({ 1: null });
  const requestCursor = kind === "issues" ? issueCursors[page] ?? searchParams.get("cursor") ?? null : null;
  const repositories = useRepositories();
  const repository = repositories.data?.items.find((item) => item.id === repositoryId);

  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    let changed = false;
    const setOrDelete = (key: string, value: string | null) => {
      if (value === null) {
        if (next.has(key)) { next.delete(key); changed = true; }
      } else if (next.get(key) !== value) {
        next.set(key, value); changed = true;
      }
    };
    if (rawDate !== null || rawFrom !== from || rawTo !== to || rawStatus !== status || rawSearch !== search || rawDomains.join("\u0000") !== domains.join("\u0000")) {
      next.delete("date");
      setOrDelete("from", from);
      setOrDelete("to", to);
      setOrDelete("status", status);
      setOrDelete("search", search || null);
      next.delete("domain");
      for (const domain of domains) next.append("domain", domain);
      next.set("page", "1");
      next.delete("cursor");
      changed = true;
    }
    if (kind === "issues") {
      if (next.has("view")) { next.delete("view"); changed = true; }
    } else {
      setOrDelete("view", rawView === null ? null : view);
    }
    if (kind === "pulls") {
      if (rawPage !== String(page)) { next.set("page", String(page)); changed = true; }
      if (next.has("cursor")) { next.delete("cursor"); changed = true; }
    } else if (next.has("page")) {
      next.delete("page"); changed = true;
    }
    if (changed) setSearchParams(next, { replace: true });
  }, [domains, filterKey, from, kind, page, rawDate, rawDomains, rawFrom, rawPage, rawSearch, rawStatus, rawTo, rawView, search, searchParams, setSearchParams, status, to, view]);
  useEffect(() => {
    setIssueCursors({ 1: null });
    setIssuePage(1);
  }, [filterKey, kind, repositoryId]);

  const list = useQuery({
    queryKey: ["metadata", repositoryId, kind, view, filterKey, page, requestCursor],
    enabled: repositoryId.length > 0,
    queryFn: ({ signal }) => fetchList(repositoryId, kind, {
      from,
      to,
      status,
      search,
      domains,
      page: kind === "pulls" ? page : null,
      cursor: kind === "issues" ? requestCursor : null,
      sort: kind === "pulls" ? (view === "number" ? "number" : "updated") : null,
      limit: PAGE_SIZE,
    }, signal),
    placeholderData: keepPreviousData,
  });
  const pageData = list.data as (typeof list.data & Partial<PagedMetadata>) | undefined;
  const items = list.data?.items ?? [];
  const totalCount = pageData?.totalCount ?? items.length;
  const totalPages = pageData?.totalPages === undefined ? Math.max(1, Math.ceil(totalCount / PAGE_SIZE)) : Math.max(1, pageData.totalPages);
  const pageSize = pageData?.pageSize ?? PAGE_SIZE;
  const nextCursor = kind === "issues" && list.data && "nextCursor" in list.data ? list.data.nextCursor : null;
  const isLoading = list.isPending;

  useEffect(() => {
    if (kind !== "pulls" || pageData?.totalPages === undefined || page <= Math.max(1, pageData.totalPages)) return;
    const next = new URLSearchParams(searchParams);
    next.set("page", String(Math.max(1, pageData.totalPages)));
    setSearchParams(next, { replace: true });
  }, [kind, page, pageData?.totalPages, searchParams, setSearchParams]);

  if (repositories.isPending) return <p role="status">Loading repositories…</p>;
  if (repositories.isError) return <p role="alert">Unable to load repositories: {repositories.error.message}</p>;
  if (!repository) return <section><h2>Repository not found</h2><p role="alert">This repository is missing or disabled.</p><Link to="/">Choose another repository</Link></section>;

  const updateUrl = (mutate: (next: URLSearchParams) => void) => {
    const next = new URLSearchParams(searchParams);
    mutate(next);
    if (kind === "pulls") next.set("page", "1"); else next.delete("page");
    next.delete("cursor");
    if (kind === "issues") {
      setIssueCursors({ 1: null });
      setIssuePage(1);
    }
    setSearchParams(next);
  };
  const changeView = (nextView: PullRequestView) => updateUrl((next) => next.set("view", nextView));
  const setDomains = (values: string[]) => updateUrl((next) => { next.delete("domain"); for (const value of values) next.append("domain", value); });
  const changeFilter = (key: "status", value: string | null) => updateUrl((next) => { if (value) next.set(key, value); else next.delete(key); });
  const changeDate = (value: DateRangeValue) => updateUrl((next) => { next.delete("date"); if (value.from) next.set("from", value.from); else next.delete("from"); if (value.to) next.set("to", value.to); else next.delete("to"); });
  const changeSearch = (value: string) => updateUrl((next) => { if (value.trim()) next.set("search", value); else next.delete("search"); });

  return <section className="metadata-page" aria-labelledby="metadata-heading">
    <div className="metadata-page__heading page-heading"><div><p className="eyebrow">Repository metadata</p><h2 id="metadata-heading">{kind === "pulls" ? "Pull requests" : "Issues"}</h2></div></div>
    <div className="metadata-panel">
      {kind === "pulls" && <nav className="metadata-view-tabs" aria-label="Pull request views"><button type="button" className={view === "updated" ? "is-active" : ""} aria-pressed={view === "updated"} onClick={() => changeView("updated")}>Recently updated</button><button type="button" className={view === "number" ? "is-active" : ""} aria-pressed={view === "number"} onClick={() => changeView("number")}>PR number</button></nav>}
      <div className="metadata-toolbar"><FilterBar kind={kind} from={from} to={to} calendarTimeZone={pageData?.calendarTimeZone} status={status} search={search} onDateRange={changeDate} onStatus={(value) => changeFilter("status", value)} onSearch={changeSearch} /></div>
      <ReclassificationHint repositoryId={repository.id} />
      {kind === "pulls" && <DomainFilter repositoryId={repository.id} selected={domains} onChange={setDomains} />}
      {isLoading && <p role="status">Loading {kind}…</p>}
      {list.isError && !list.isFetching && <p role="alert">Unable to load {kind}: {list.error instanceof Error ? list.error.message : "Unknown error"}</p>}
      {!isLoading && !list.isError && items.length === 0 && <p role="status">No {kind} match these filters.</p>}
      {!isLoading && !list.isError && items.length > 0 && <MetadataFeed kind={kind} items={items} calendarTimeZone={pageData?.calendarTimeZone} />}
      {kind === "pulls" && !list.isError && (items.length > 0 || totalCount > 0) && <Pagination page={page} pageSize={pageSize} totalCount={totalCount} totalPages={totalPages} onPageChange={(nextPage) => { const next = new URLSearchParams(searchParams); next.set("page", String(nextPage)); next.delete("cursor"); setSearchParams(next); }} disabled={list.isFetching} label="Pull requests pagination" />}
      {kind === "issues" && !list.isError && (items.length > 0 || page > 1) && <nav className="metadata-pagination" aria-label="Issues pagination"><span className="metadata-pagination__summary">Page {page} · {items.length} items</span><button type="button" onClick={() => { const targetPage = page - 1; setIssuePage(targetPage); const next = new URLSearchParams(searchParams); if (targetPage <= 1) next.delete("cursor"); else if (issueCursors[targetPage]) next.set("cursor", issueCursors[targetPage]); else next.delete("cursor"); setSearchParams(next); }} disabled={list.isFetching || page <= 1}>Previous</button><button type="button" onClick={() => { if (!nextCursor) return; const targetPage = page + 1; setIssueCursors((current) => ({ ...current, [targetPage]: nextCursor })); setIssuePage(targetPage); const next = new URLSearchParams(searchParams); next.set("cursor", nextCursor); setSearchParams(next); }} disabled={list.isFetching || nextCursor === null}>Next</button></nav>}
      {list.isFetching && !isLoading && <p role="status">Refreshing…</p>}
    </div>
    <p className="query-debug" aria-hidden="true">{buildListUrl(repository.id, kind, { from, to, status, search, domains, page: kind === "pulls" ? page : null, sort: kind === "pulls" ? (view === "number" ? "number" : "updated") : null, limit: PAGE_SIZE })}</p>
  </section>;
}
