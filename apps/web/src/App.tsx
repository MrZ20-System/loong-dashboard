import {
  QueryClient,
  QueryClientProvider,
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Link,
  Route,
  Routes,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { fetchHealth } from "./health-client";
import {
  buildListUrl,
  fetchList,
  fetchRepositories,
  fetchSyncStatus,
  readMetadataFilters,
  startSync,
  type IssueListItem,
  type PullRequestListItem,
  type RepositorySummary,
} from "./metadata-client";

export const appQueryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, retry: false } } });
const pullStatuses = ["draft", "open", "closed", "merged"] as const;
const issueStatuses = ["open", "closed"] as const;

function HealthStatus() {
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void fetchHealth().then(() => active && setStatus("ok")).catch((reason: unknown) => {
      if (active) { setStatus("error"); setError(reason instanceof Error ? reason.message : String(reason)); }
    });
    return () => { active = false; };
  }, []);
  if (status === "loading") return <p role="status">Checking API health…</p>;
  if (status === "error") return <p role="alert">API health check failed: {error}</p>;
  return <p role="status">API status: healthy</p>;
}

function RepositorySelector({ repositories, selectedId }: { repositories: RepositorySummary[]; selectedId?: string }) {
  const navigate = useNavigate();
  const selected = selectedId ?? repositories[0]?.id;
  return <label className="repository-selector">Repository
    <select aria-label="Repository" value={selected ?? ""} onChange={(event) => navigate(`/repositories/${encodeURIComponent(event.target.value)}/pulls`)}>
      {repositories.map((repository) => <option key={repository.id} value={repository.id}>{repository.displayName} ({repository.githubOwner}/{repository.githubName})</option>)}
    </select>
  </label>;
}

function RepositoryPicker() {
  const repositories = useQuery({ queryKey: ["repositories"], queryFn: ({ signal }) => fetchRepositories(signal) });
  if (repositories.isPending) return <p role="status">Loading repositories…</p>;
  if (repositories.isError) return <p role="alert">Unable to load repositories: {repositories.error.message}</p>;
  if (repositories.data.items.length === 0) return <p role="status">No configured repositories.</p>;
  const repository = repositories.data.items[0];
  return <><RepositorySelector repositories={repositories.data.items} /><div className="repository-actions" aria-label="Repository metadata actions"><Link to={`/repositories/${encodeURIComponent(repository.id)}/pulls`}>Open Pull Requests</Link><Link to={`/repositories/${encodeURIComponent(repository.id)}/issues`}>Open Issues</Link></div></>;
}

function HomePage() {
  return <section aria-labelledby="welcome-heading"><p className="eyebrow">Local-first engineering workspace</p><h2 id="welcome-heading">A clear view of your repositories and knowledge.</h2><p>LoongBoard brings local Git workspaces, durable Markdown knowledge, and coding-agent sessions together in one focused board.</p><RepositoryPicker /><HealthStatus /></section>;
}

function FilterBar({ kind, date, status, onDate, onStatus }: { kind: "pulls" | "issues"; date: string | null; status: string | null; onDate: (value: string) => void; onStatus: (value: string) => void }) {
  const statuses = kind === "pulls" ? pullStatuses : issueStatuses;
  return <form className="filters" aria-label="Metadata filters" onSubmit={(event) => event.preventDefault()}><label>Activity date<input aria-label="Activity date" type="date" value={date ?? ""} onChange={(event) => onDate(event.target.value)} /></label><label>Status<select aria-label="Status" value={status ?? ""} onChange={(event) => onStatus(event.target.value)}><option value="">All statuses</option>{statuses.map((value) => <option key={value} value={value}>{value}</option>)}</select></label></form>;
}

function SyncControl({ repositoryId }: { repositoryId: string }) {
  const client = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const sync = useMutation({ mutationFn: () => startSync(repositoryId), onSuccess: (accepted) => {
    setMessage("Sync started.");
    const statusKey = ["sync", repositoryId] as const;
    const attemptKey = ["sync-attempt", repositoryId] as const;
    const statusState = client.getQueryState(statusKey);
    client.setQueryData(attemptKey, { syncRunId: accepted.syncRunId, statusDataUpdatedAt: statusState?.data === undefined ? null : statusState.dataUpdatedAt, waitForStatusRefresh: true, statusRefreshRequestedAt: null });
  }, onError: (error: Error) => setMessage(`Sync failed: ${error.message}`) });
  return <div className="sync-control"><button type="button" onClick={() => { setMessage(null); sync.mutate(); }} disabled={sync.isPending}>{sync.isPending ? "Starting sync…" : "Sync now"}</button>{message && <p role={sync.isError ? "alert" : "status"}>{message}</p>}</div>;
}

function SyncStatus({ repositoryId }: { repositoryId: string }) {
  const client = useQueryClient();
  const status = useQuery({ queryKey: ["sync", repositoryId], queryFn: ({ signal }) => fetchSyncStatus(repositoryId, signal), refetchInterval: (query) => query.state.data?.status === "running" ? 1000 : false });
  const accepted = useQuery<{ syncRunId: string; statusDataUpdatedAt: number | null; waitForStatusRefresh: boolean; statusRefreshRequestedAt: number | null } | null>({ queryKey: ["sync-attempt", repositoryId], queryFn: async () => null, enabled: false });
  const acceptedRunId = accepted.data?.syncRunId;
  const previousStreams = useRef<{ pullRequests: "idle" | "running" | "failed"; issues: "idle" | "running" | "failed" } | null>(null);
  const previousRepositoryId = useRef(repositoryId);
  const firstStatusEffect = useRef(true);
  useEffect(() => {
    const isFirstStatusEffect = firstStatusEffect.current;
    firstStatusEffect.current = false;
    let repositoryChanged = false;
    if (previousRepositoryId.current !== repositoryId) {
      previousRepositoryId.current = repositoryId;
      previousStreams.current = null;
      repositoryChanged = true;
    }
    if (!status.data) return;
    const streams = { pullRequests: status.data.pullRequests, issues: status.data.issues };
    const previous = previousStreams.current;
    const handledKey = ["sync-handled", repositoryId] as const;
    let handled = client.getQueryData<{ syncRunId: string; pullRequests: boolean; issues: boolean }>(handledKey);
    const isNewAttempt = acceptedRunId !== null && acceptedRunId !== handled?.syncRunId;
    if (isNewAttempt && acceptedRunId) {
      handled = { syncRunId: acceptedRunId, pullRequests: false, issues: false };
      client.setQueryData(handledKey, handled);
    }
    let acceptedAttempt = accepted.data;
    if (acceptedAttempt?.waitForStatusRefresh) {
      if (acceptedAttempt.statusDataUpdatedAt === null) {
        acceptedAttempt = { ...acceptedAttempt, statusDataUpdatedAt: status.dataUpdatedAt };
        client.setQueryData(["sync-attempt", repositoryId], acceptedAttempt);
      } else if (status.dataUpdatedAt > acceptedAttempt.statusDataUpdatedAt) {
        acceptedAttempt = { ...acceptedAttempt, waitForStatusRefresh: false, statusRefreshRequestedAt: null };
        client.setQueryData(["sync-attempt", repositoryId], acceptedAttempt);
      }
      if (acceptedAttempt.waitForStatusRefresh) {
        const shouldRefresh = isFirstStatusEffect || repositoryChanged || acceptedAttempt.statusRefreshRequestedAt !== status.dataUpdatedAt;
        if (shouldRefresh) {
          const requestedAttempt = { ...acceptedAttempt, statusRefreshRequestedAt: status.dataUpdatedAt };
          client.setQueryData(["sync-attempt", repositoryId], requestedAttempt);
          void client.refetchQueries({ queryKey: ["sync", repositoryId] });
        }
        previousStreams.current = { pullRequests: streams.pullRequests.status, issues: streams.issues.status };
        return;
      }
    }
    const acceptedStatusReady = acceptedAttempt?.waitForStatusRefresh === false && (acceptedAttempt.statusDataUpdatedAt === null || status.dataUpdatedAt > acceptedAttempt.statusDataUpdatedAt);
    for (const [streamName, stream] of Object.entries(streams) as Array<["pullRequests" | "issues", typeof streams.pullRequests]>) {
      if (!handled || handled[streamName]) continue;
      const reachedSuccessfulTerminal = stream.status === "idle" && (
        acceptedRunId !== null && acceptedStatusReady && (
          (acceptedAttempt !== null && acceptedAttempt !== undefined && acceptedAttempt.statusDataUpdatedAt !== null) || isNewAttempt || previous?.[streamName] === "running"
        )
      );
      if (reachedSuccessfulTerminal) {
        handled = { ...handled, [streamName]: true };
        client.setQueryData(handledKey, handled);
        const kind = streamName === "pullRequests" ? "pulls" : "issues";
        void client.invalidateQueries({ queryKey: ["metadata", repositoryId, kind] });
      }
    }
    previousStreams.current = { pullRequests: streams.pullRequests.status, issues: streams.issues.status };
  }, [accepted.data, acceptedRunId, client, repositoryId, status.data, status.dataUpdatedAt]);
  if (status.isPending) return <span role="status">Checking sync status…</span>;
  if (status.isError) return <span role="alert">Sync status unavailable: {status.error.message}</span>;
  if (status.data.status === "running") return <span role="status">Sync in progress…</span>;
  if (status.data.status === "failed") return <span role="alert">Last sync failed. Existing rows remain available.</span>;
  return <span role="status">Sync idle</span>;
}

function Metrics({ kind, items }: { kind: "pulls" | "issues"; items: Array<PullRequestListItem | IssueListItem> }) {
  const values = useMemo(() => {
    if (kind === "pulls") { const pulls = items as PullRequestListItem[]; return { primary: pulls.length, label: "Pull requests", secondary: pulls.reduce((sum, item) => sum + item.changedFilesCount, 0), secondaryLabel: "Changed files", tertiary: pulls.reduce((sum, item) => sum + item.additions + item.deletions, 0), tertiaryLabel: "Line changes" }; }
    const issues = items as IssueListItem[]; return { primary: issues.length, label: "Issues", secondary: issues.reduce((sum, item) => sum + item.commentsCount, 0), secondaryLabel: "Comments", tertiary: 0, tertiaryLabel: "Line changes" };
  }, [items, kind]);
  return <dl className="metrics" aria-label="List metrics"><div><dt>{values.label}</dt><dd>{values.primary}</dd></div><div><dt>{values.secondaryLabel}</dt><dd>{values.secondary}</dd></div><div><dt>{values.tertiaryLabel}</dt><dd>{values.tertiary}</dd></div></dl>;
}

function MetadataTable({ kind, items }: { kind: "pulls" | "issues"; items: Array<PullRequestListItem | IssueListItem> }) {
  if (kind === "pulls") return <table><caption>Pull requests</caption><thead><tr><th scope="col">Number</th><th scope="col">Title</th><th scope="col">Author</th><th scope="col">Status</th><th scope="col">Updated</th><th scope="col">Files</th><th scope="col">Additions</th><th scope="col">Deletions</th></tr></thead><tbody>{(items as PullRequestListItem[]).map((item) => <tr key={item.number}><td>#{item.number}</td><td><a href={item.url} target="_blank" rel="noreferrer">{item.title}</a></td><td>{item.authorLogin ?? "Unknown"}</td><td>{item.status}</td><td>{item.updatedAt}</td><td>{item.changedFilesCount}</td><td>{item.additions}</td><td>{item.deletions}</td></tr>)}</tbody></table>;
  return <table><caption>Issues</caption><thead><tr><th scope="col">Number</th><th scope="col">Title</th><th scope="col">Author</th><th scope="col">Status</th><th scope="col">Updated</th><th scope="col">Comments</th></tr></thead><tbody>{(items as IssueListItem[]).map((item) => <tr key={item.number}><td>#{item.number}</td><td><a href={item.url} target="_blank" rel="noreferrer">{item.title}</a></td><td>{item.authorLogin ?? "Unknown"}</td><td>{item.status}</td><td>{item.updatedAt}</td><td>{item.commentsCount}</td></tr>)}</tbody></table>;
}

function MetadataPage({ kind }: { kind: "pulls" | "issues" }) {
  const { repositoryId = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { date, status } = readMetadataFilters(kind, searchParams);
  const rawDate = searchParams.get("date"); const rawStatus = searchParams.get("status");
  const filterKey = `${date ?? ""}:${status ?? ""}`;
  useEffect(() => {
    if (rawDate !== date || rawStatus !== status) { const next = new URLSearchParams(searchParams); if (date) next.set("date", date); else next.delete("date"); if (status) next.set("status", status); else next.delete("status"); next.delete("cursor"); setSearchParams(next, { replace: true }); }
  }, [date, rawDate, rawStatus, searchParams, setSearchParams, status]);
  const repositories = useQuery({ queryKey: ["repositories"], queryFn: ({ signal }) => fetchRepositories(signal) });
  const repository = repositories.data?.items.find((item) => item.id === repositoryId);
  const initialCursor = searchParams.get("cursor");
  const list = useInfiniteQuery({ queryKey: ["metadata", repositoryId, kind, filterKey, initialCursor], enabled: repositoryId.length > 0, initialPageParam: initialCursor, queryFn: ({ pageParam, signal }) => fetchList(repositoryId, kind, { date, status, cursor: pageParam }, signal), getNextPageParam: (page) => page.nextCursor ?? undefined, placeholderData: keepPreviousData });
  const items = list.data?.pages.flatMap((page) => page.items as Array<PullRequestListItem | IssueListItem>) ?? [];
  const calendarTimeZone = list.data?.pages[0]?.calendarTimeZone;
  if (repositories.isPending) return <p role="status">Loading repositories…</p>;
  if (repositories.isError) return <p role="alert">Unable to load repositories: {repositories.error.message}</p>;
  if (!repository) return <section><h2>Repository not found</h2><p role="alert">This repository is missing or disabled.</p><Link to="/">Choose another repository</Link></section>;
  const changeFilter = (key: "date" | "status", value: string) => { const next = new URLSearchParams(searchParams); if (value) next.set(key, value); else next.delete(key); next.delete("cursor"); setSearchParams(next); };
  const siblingKind = kind === "pulls" ? "issues" : "pulls";
  const siblingStatuses = siblingKind === "pulls" ? pullStatuses : issueStatuses;
  const siblingStatus = status && siblingStatuses.includes(status as never) ? status : null;
  const siblingParams = new URLSearchParams(); if (date) siblingParams.set("date", date); if (siblingStatus) siblingParams.set("status", siblingStatus);
  const siblingHref = `/repositories/${encodeURIComponent(repository.id)}/${siblingKind}${siblingParams.toString() ? `?${siblingParams.toString()}` : ""}`;
  const currentParams = new URLSearchParams(); if (date) currentParams.set("date", date); if (status) currentParams.set("status", status);
  const currentHref = `/repositories/${encodeURIComponent(repository.id)}/${kind}${currentParams.toString() ? `?${currentParams.toString()}` : ""}`;
  return <section className="metadata-page" aria-labelledby="metadata-heading"><div className="page-heading"><div><p className="eyebrow">{repository.githubOwner}/{repository.githubName}</p><h2 id="metadata-heading">{kind === "pulls" ? "Pull requests" : "Issues"}</h2></div><Link to="/">Change repository</Link></div><RepositorySelector repositories={repositories.data.items} selectedId={repository.id} /><nav className="sibling-navigation" aria-label="Repository metadata navigation"><Link to={kind === "pulls" ? currentHref : siblingHref}>Pull requests</Link><Link to={kind === "issues" ? currentHref : siblingHref}>Issues</Link></nav><div className="sync-status"><SyncStatus repositoryId={repository.id} /><SyncControl repositoryId={repository.id} /></div><FilterBar kind={kind} date={date} status={status} onDate={(value) => changeFilter("date", value)} onStatus={(value) => changeFilter("status", value)} />{calendarTimeZone && <p className="timezone">Calendar timezone: {calendarTimeZone}</p>}{list.isPending && <p role="status">Loading {kind}…</p>}{list.isError && !list.isFetching && <p role="alert">Unable to load {kind}: {list.error.message}</p>}{!list.isPending && !list.isError && items.length === 0 && <p role="status">No {kind} match these filters.</p>}{(items.length > 0 || list.isFetching) && <><Metrics kind={kind} items={items} /><MetadataTable kind={kind} items={items} /></>}{list.hasNextPage && <button type="button" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>{list.isFetchingNextPage ? "Loading more…" : "Load more"}</button>}{list.isFetching && !list.isFetchingNextPage && <p role="status">Refreshing…</p>}<p className="query-debug" aria-hidden="true">{buildListUrl(repository.id, kind, { date, status })}</p></section>;
}

function HealthPage() { return <section aria-labelledby="health-heading"><p className="eyebrow">System</p><h2 id="health-heading">Service health</h2><p>The web shell checks the API boundary without hiding failures.</p><HealthStatus /></section>; }
function NotFoundPage() { return <section aria-labelledby="not-found-heading"><p className="eyebrow">Not found</p><h2 id="not-found-heading">This LoongBoard route does not exist.</h2><Link to="/">Return to the board</Link></section>; }
function AppRoutes() { return <div className="app-shell"><header className="app-header"><div><p className="brand-mark">LB</p><h1>LoongBoard</h1><p className="tagline">Your local engineering command center</p></div><nav aria-label="Primary navigation"><Link to="/">Board</Link><Link to="/health">Health</Link></nav></header><main className="app-content"><Routes><Route path="/" element={<HomePage />} /><Route path="/health" element={<HealthPage />} /><Route path="/repositories/:repositoryId/pulls" element={<MetadataPage kind="pulls" />} /><Route path="/repositories/:repositoryId/issues" element={<MetadataPage kind="issues" />} /><Route path="*" element={<NotFoundPage />} /></Routes></main><footer className="app-footer">Stage 1 · GitHub metadata</footer></div>; }
export function App() { return <QueryClientProvider client={appQueryClient}><AppRoutes /></QueryClientProvider>; }
