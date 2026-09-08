import {
  keepPreviousData,
  useInfiniteQuery,
} from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useDomains, useRepositories } from "../../app/hooks";
import { DomainFilter } from "../../components/domain/DomainFilter";
import {
  DateDayFilter,
  type DateRangeValue,
} from "../../components/filters/DateDayFilter";
import { FilterDropdown } from "../../components/filters/FilterDropdown";
import {
  matchesMetadataSearch,
  MetadataFeed,
  MetadataSearchField,
} from "../../components/metadata/MetadataList";
import {
  buildListUrl,
  fetchList,
  readMetadataFilters,
  type IssueListItem,
  type PullRequestListItem,
} from "../../metadata-client";

export const pullStatuses = ["draft", "open", "closed", "merged"] as const;
export const issueStatuses = ["open", "closed"] as const;

function ReclassificationHint({ repositoryId }: { repositoryId: string }) {
  const domains = useDomains(repositoryId);
  if (!domains.data?.reclassification.running) return null;
  return <p role="status" className="reclassify-hint">重新分类中…</p>;
}

function FilterBar({
  kind,
  from,
  to,
  calendarTimeZone,
  status,
  search,
  onDateRange,
  onStatus,
  onSearch,
}: {
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
  return (
    <form
      className="filters"
      aria-label="Metadata filters"
      onSubmit={(event) => event.preventDefault()}
    >
      <DateDayFilter
        from={from}
        to={to}
        calendarTimeZone={calendarTimeZone}
        onChange={onDateRange}
      />
      <MetadataSearchField kind={kind} value={search} onChange={onSearch} />
      <FilterDropdown
        label="Status"
        emptyLabel="All statuses"
        options={statuses.map((value) => ({ value, label: value }))}
        selected={status ? [status] : []}
        onChange={(values) => onStatus(values[0] ?? "")}
      />
    </form>
  );
}

export function MetadataPage({ kind }: { kind: "pulls" | "issues" }) {
  const { repositoryId = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const [searchQuery, setSearchQuery] = useState("");
  const { from, to, status, domains } = readMetadataFilters(kind, searchParams);
  const rawFrom = searchParams.get("from");
  const rawTo = searchParams.get("to");
  const rawDate = searchParams.get("date");
  const rawStatus = searchParams.get("status");
  const rawDomains = kind === "pulls" ? searchParams.getAll("domain") : [];
  const filterKey = `${from ?? ""}:${to ?? ""}:${status ?? ""}${
    domains.length > 0 ? `:${domains.join(",")}` : ""
  }`;
  const domainsKey = rawDomains.join("\u0000");
  useEffect(() => {
    if (
      rawFrom !== from ||
      rawTo !== to ||
      rawDate !== null ||
      rawStatus !== status ||
      rawDomains.join("\u0000") !== domains.join("\u0000")
    ) {
      const next = new URLSearchParams(searchParams);
      next.delete("date");
      if (from) next.set("from", from);
      else next.delete("from");
      if (to) next.set("to", to);
      else next.delete("to");
      if (status) next.set("status", status);
      else next.delete("status");
      next.delete("domain");
      for (const id of domains) next.append("domain", id);
      next.delete("cursor");
      setSearchParams(next, { replace: true });
    }
  }, [domains, domainsKey, from, rawDate, rawFrom, rawStatus, rawTo, searchParams, setSearchParams, status, to]);
  const repositories = useRepositories();
  const repository = repositories.data?.items.find((item) => item.id === repositoryId);
  const initialCursor = searchParams.get("cursor");
  const list = useInfiniteQuery({
    queryKey: ["metadata", repositoryId, kind, filterKey, initialCursor],
    enabled: repositoryId.length > 0,
    initialPageParam: initialCursor,
    queryFn: ({ pageParam, signal }) =>
      fetchList(repositoryId, kind, { from, to, status, domains, cursor: pageParam }, signal),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });
  const items =
    list.data?.pages.flatMap(
      (page) => page.items as Array<PullRequestListItem | IssueListItem>,
    ) ?? [];
  const searchableItems = useMemo(
    () =>
      searchQuery.trim().length === 0
        ? items
        : items.filter((item) =>
            matchesMetadataSearch(item, searchQuery),
          ),
    [items, searchQuery],
  );
  const calendarTimeZone = list.data?.pages[0]?.calendarTimeZone;
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
  const changeFilter = (key: "date" | "status", value: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete("cursor");
    setSearchParams(next);
  };
  const setDomains = (values: string[]) => {
    const next = new URLSearchParams(searchParams);
    next.delete("domain");
    for (const value of values) next.append("domain", value);
    next.delete("cursor");
    setSearchParams(next);
  };
  return (
    <section className="metadata-page" aria-labelledby="metadata-heading">
      <div className="metadata-page__heading page-heading">
        <div>
          <p className="eyebrow">Repository metadata</p>
          <h2 id="metadata-heading">
            {kind === "pulls" ? "Pull requests" : "Issues"}
          </h2>
        </div>
      </div>
      <div className="metadata-panel">
        <div className="metadata-toolbar">
          <FilterBar
            kind={kind}
            from={from}
            to={to}
            calendarTimeZone={calendarTimeZone}
            status={status}
            search={searchQuery}
            onDateRange={(value) => {
              const next = new URLSearchParams(searchParams);
              next.delete("date");
              if (value.from) next.set("from", value.from);
              else next.delete("from");
              if (value.to) next.set("to", value.to);
              else next.delete("to");
              next.delete("cursor");
              setSearchParams(next);
            }}
            onStatus={(value) => changeFilter("status", value)}
            onSearch={setSearchQuery}
          />
        </div>
        <ReclassificationHint repositoryId={repository.id} />
        {kind === "pulls" && (
          <DomainFilter
            repositoryId={repository.id}
            selected={domains}
            onChange={setDomains}
          />
        )}
        {list.isPending && <p role="status">Loading {kind}…</p>}
        {list.isError && !list.isFetching && (
          <p role="alert">Unable to load {kind}: {list.error.message}</p>
        )}
        {!list.isPending && !list.isError && items.length === 0 && (
          <p role="status">No {kind} match these filters.</p>
        )}
        {(items.length > 0 || list.isFetching) && (
          searchableItems.length === 0 ? (
            <p role="status">No {kind} match your search.</p>
          ) : (
            <MetadataFeed kind={kind} items={searchableItems} />
          )
        )}
        {list.hasNextPage && (
          <button
            className="load-more"
            type="button"
            onClick={() => void list.fetchNextPage()}
            disabled={list.isFetchingNextPage}
          >
            {list.isFetchingNextPage ? "Loading more…" : "Load more"}
          </button>
        )}
        {list.isFetching && !list.isFetchingNextPage && (
          <p role="status">Refreshing…</p>
        )}
      </div>
      <p className="query-debug" aria-hidden="true">
        {buildListUrl(repository.id, kind, { from, to, status, domains })}
      </p>
    </section>
  );
}
