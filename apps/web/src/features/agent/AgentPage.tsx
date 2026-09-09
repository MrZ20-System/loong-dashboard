import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { AgentScope, AgentScopeKind, AgentSessionSummary } from "@loongboard/contracts";
import { deleteAgentSession, ensureAgentSession, listAgentSessions } from "../../agent-chat-client";
import { AgentChatPanel } from "../../agent-chat";
import { useRepositories } from "../../app/hooks";
import { useAgentSessionSelection } from "./agent-session-context";

const kinds: Array<{ value: AgentScopeKind | "all"; label: string }> = [
  { value: "all", label: "All origins" }, { value: "general", label: "General" },
  { value: "pr", label: "Pull requests" }, { value: "issue", label: "Issues" }, { value: "knowledge", label: "Knowledge" }, { value: "repository", label: "Repository" }, { value: "domain", label: "Domains" },
];
const statuses = ["all", "idle", "running", "interrupted", "error"] as const;
type SessionStatusFilter = (typeof statuses)[number];

function originLabel(session: AgentSessionSummary) {
  if (session.scope.kind === "pr") return `PR #${session.scope.prNumber}`;
  if (session.scope.kind === "issue") return `Issue #${session.scope.issueNumber}`;
  if (session.scope.kind === "knowledge") return `Knowledge ${session.scope.knowledgeDocumentId ?? ""}`;
  if (session.scope.kind === "repository") return "Repository conversation";
  if (session.scope.kind === "domain") return `Domain ${session.scope.domainId ?? ""}`;
  return "General";
}

function sourceHref(session: AgentSessionSummary) {
  const scope = session.scope;
  if (scope.kind === "pr" && scope.repositoryId && scope.prNumber) return `/repositories/${encodeURIComponent(scope.repositoryId)}/pulls/${scope.prNumber}`;
  if (scope.kind === "issue" && scope.repositoryId && scope.issueNumber) return `/repositories/${encodeURIComponent(scope.repositoryId)}/issues/${scope.issueNumber}`;
  if (scope.kind === "knowledge" && scope.knowledgeDocumentId) return `/knowledge/${encodeURIComponent(scope.knowledgeDocumentId)}`;
  if ((scope.kind === "repository" || scope.kind === "general") && scope.repositoryId) return `/repositories/${encodeURIComponent(scope.repositoryId)}`;
  if (scope.kind === "domain" && scope.repositoryId) return `/settings/domains?repository=${encodeURIComponent(scope.repositoryId)}`;
  return "/";
}

function newSessionScope(origin: AgentScopeKind | "all", repositoryId: string): AgentScope {
  if (origin === "repository" && repositoryId !== "") return { kind: "repository", repositoryId };
  if (origin === "domain" && repositoryId !== "") return { kind: "domain", repositoryId, domainId: "domains" };
  return repositoryId !== "" ? { kind: "general", repositoryId } : { kind: "general" };
}

export function AgentPage() {
  const [params, setParams] = useSearchParams();
  const client = useQueryClient();
  const [search, setSearch] = useState("");
  const [origin, setOrigin] = useState<AgentScopeKind | "all">((params.get("origin") as AgentScopeKind | "all" | null) ?? "all");
  const [repository, setRepository] = useState(params.get("repository") ?? "");
  const [status, setStatus] = useState<SessionStatusFilter>((params.get("status") as SessionStatusFilter | null) ?? "all");
  const repositories = useRepositories();
  const sessions = useQuery({ queryKey: ["agent-sessions", "all"], queryFn: () => listAgentSessions({}) , refetchInterval: 3000 });
  const selectedId = params.get("session");
  const filtered = useMemo(() => (sessions.data?.items ?? []).filter((session) => {
    if (origin !== "all" && session.scope.kind !== origin) return false;
    if (repository !== "" && session.scope.repositoryId !== repository) return false;
    if (status !== "all" && session.status !== status) return false;
    const text = `${session.id} ${originLabel(session)} ${session.scope.repositoryId ?? ""} ${session.model}`.toLowerCase();
    return text.includes(search.trim().toLowerCase());
  }), [origin, repository, search, status, sessions.data]);
  const selected = filtered.find((session) => session.id === selectedId) ?? sessions.data?.items.find((session) => session.id === selectedId);
  const selectedSelection = useAgentSessionSelection(selected ? JSON.stringify(selected.scope) : "agent:none");
  const remove = useMutation({
    mutationFn: ({ id }: { id: string; scopeKey: string }) => deleteAgentSession(id),
    onSuccess: (_result, variables) => {
      void client.invalidateQueries({ queryKey: ["agent-sessions", "all"] });
      selectedSelection.clearSessionId(variables.id);
      const next = new URLSearchParams(params);
      if (next.get("session") === variables.id) {
        next.delete("session");
        setParams(next);
      }
    },
  });
  const create = useMutation({
    mutationFn: () => ensureAgentSession(newSessionScope(origin, repository)),
    onSuccess: (view) => {
      void client.invalidateQueries({ queryKey: ["agent-sessions", "all"] });
      const next = new URLSearchParams(params);
      next.set("session", view.session.id);
      setParams(next);
    },
  });
  const select = (session: AgentSessionSummary) => { const next = new URLSearchParams(params); next.set("session", session.id); setParams(next); };
  return (
    <section className="agent-page" aria-labelledby="agent-page-heading">
      <div className="page-heading"><div><p className="eyebrow">Workspace</p><h2 id="agent-page-heading">Agent conversations</h2><p className="page-subtitle">Open the same persistent DSH conversation from any source.</p></div><button className="button-link" type="button" onClick={() => create.mutate()} disabled={create.isPending}>{create.isPending ? "Opening…" : origin === "domain" ? "Start domain update" : "New conversation"}</button></div>
      <div className="agent-page-layout">
        <aside className="agent-session-list" aria-label="Agent sessions">
          <div className="agent-session-filters"><label>Search<input aria-label="Search conversations" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search sessions" /></label><label>Origin<select aria-label="Filter by origin" value={origin} onChange={(event) => { const next = event.target.value as AgentScopeKind | "all"; setOrigin(next); const query = new URLSearchParams(params); query.set("origin", next); setParams(query); }}>{kinds.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label><label>Repository<select aria-label="Filter by repository" value={repository} onChange={(event) => { const value = event.target.value; setRepository(value); const query = new URLSearchParams(params); if (value) query.set("repository", value); else query.delete("repository"); setParams(query); }}><option value="">All repositories</option>{repositories.data?.items.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label><label>Status<select aria-label="Filter by status" value={status} onChange={(event) => { const next = event.target.value as SessionStatusFilter; setStatus(next); const query = new URLSearchParams(params); if (next === "all") query.delete("status"); else query.set("status", next); setParams(query); }}><option value="all">All statuses</option><option value="idle">Idle</option><option value="running">Running</option><option value="interrupted">Interrupted</option><option value="error">Error</option></select></label></div>
          {sessions.isPending && <p role="status">Loading conversations…</p>}{sessions.isError && <p role="alert">{sessions.error.message}</p>}{!sessions.isPending && filtered.length === 0 && <p role="status">No conversations match this filter.</p>}
          <ul>{filtered.map((session) => <li key={session.id}><div className="agent-session-row-wrap"><button type="button" className={session.id === selectedId ? "agent-session-row active" : "agent-session-row"} onClick={() => select(session)}><span className={`agent-row-status status-${session.status}`} aria-label={session.status} /><span className="agent-session-row__copy"><strong>{originLabel(session)}</strong><small>{session.scope.repositoryId ?? "Workspace"} · {new Date(session.lastUsedAt).toLocaleString()}</small></span><span className="agent-session-row__model">{session.model}</span></button><button type="button" className="agent-session-delete" aria-label={`Delete ${originLabel(session)}`} onClick={() => { if (window.confirm("Delete this conversation?")) remove.mutate({ id: session.id, scopeKey: JSON.stringify(session.scope) }); }}>×</button></div></li>)}</ul>
        </aside>
        <div className="agent-page-surface">{selected ? <><div className="agent-page-source"><span>{originLabel(selected)} · {selected.status}</span><Link to={sourceHref(selected)}>Open source</Link></div><AgentChatPanel scope={selected.scope} initialSessionId={selected.id} heading="Agent" panelId="agent-page-chat" showCollapseControl={false} /></> : <div className="agent-page-empty"><span className="settings-tile-icon">✦</span><h3>Select a conversation</h3><p>Choose an existing session to continue it with the same runtime context.</p></div>}</div>
      </div>
    </section>
  );
}
