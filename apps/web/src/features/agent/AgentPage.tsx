import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type {
  AgentScope,
  AgentScopeKind,
  AgentSessionSummary,
} from "@loongboard/contracts";
import {
  deleteAgentSession,
  ensureAgentSession,
  listAgentSessions,
  updateAgentSession,
} from "../../agent-chat-client";
import { AgentChatPanel } from "../../agent-chat";
import { useRepositories } from "../../app/hooks";
import {
  useI18n,
  type I18nContextValue,
  type LocalizedMessage,
  type MessageValues,
} from "../../i18n";
import { useAgentSessionSelection } from "./agent-session-context";
import { agentMessages } from "./messages";

const kinds: Array<{
  value: AgentScopeKind | "all";
  label: keyof typeof agentMessages;
}> = [
  { value: "all", label: "allOrigins" },
  { value: "general", label: "general" },
  { value: "pr", label: "pullRequests" },
  { value: "issue", label: "issues" },
  { value: "knowledge", label: "knowledge" },
  { value: "repository", label: "repository" },
  { value: "domain", label: "domains" },
];

const statuses = ["all", "idle", "running", "interrupted", "error"] as const;
type SessionStatusFilter = (typeof statuses)[number];

type Feedback = {
  message: LocalizedMessage;
  values?: MessageValues;
};

const originValues = new Set(kinds.map((item) => item.value));

function parseOrigin(value: string | null): AgentScopeKind | "all" {
  return value !== null && originValues.has(value as AgentScopeKind | "all")
    ? (value as AgentScopeKind | "all")
    : "all";
}

function parseStatus(value: string | null): SessionStatusFilter {
  return value !== null && (statuses as readonly string[]).includes(value)
    ? (value as SessionStatusFilter)
    : "all";
}

function originLabel(
  session: AgentSessionSummary,
  t: I18nContextValue["t"],
): string {
  if (session.scope.kind === "pr") {
    return t(agentMessages.prOrigin, { number: session.scope.prNumber });
  }
  if (session.scope.kind === "issue") {
    return t(agentMessages.issueOrigin, { number: session.scope.issueNumber });
  }
  if (session.scope.kind === "knowledge") {
    return t(agentMessages.knowledgeOrigin, {
      id: session.scope.knowledgeDocumentId ?? "",
    });
  }
  if (session.scope.kind === "repository") {
    return t(agentMessages.repositoryConversation);
  }
  if (session.scope.kind === "domain") {
    return t(agentMessages.domainOrigin, {
      id: session.scope.domainId ?? "",
    });
  }
  return t(agentMessages.general);
}

function sessionTitle(
  session: AgentSessionSummary,
  t: I18nContextValue["t"],
): string {
  return session.title?.trim() || originLabel(session, t);
}

function sourceHref(session: AgentSessionSummary): string {
  const scope = session.scope;
  if (scope.kind === "pr" && scope.repositoryId && scope.prNumber) {
    return `/repositories/${encodeURIComponent(scope.repositoryId)}/pulls/${scope.prNumber}`;
  }
  if (scope.kind === "issue" && scope.repositoryId && scope.issueNumber) {
    return `/repositories/${encodeURIComponent(scope.repositoryId)}/issues/${scope.issueNumber}`;
  }
  if (scope.kind === "knowledge" && scope.knowledgeDocumentId) {
    return `/knowledge/${encodeURIComponent(scope.knowledgeDocumentId)}`;
  }
  if (
    (scope.kind === "repository" || scope.kind === "general") &&
    scope.repositoryId
  ) {
    return `/repositories/${encodeURIComponent(scope.repositoryId)}`;
  }
  if (scope.kind === "domain" && scope.repositoryId) {
    return `/settings/domains?repository=${encodeURIComponent(scope.repositoryId)}`;
  }
  return "/";
}

function newSessionScope(
  origin: AgentScopeKind | "all",
  repositoryId: string,
): AgentScope {
  if (origin === "repository" && repositoryId !== "") {
    return { kind: "repository", repositoryId };
  }
  if (origin === "domain" && repositoryId !== "") {
    return { kind: "domain", repositoryId, domainId: "domains" };
  }
  return repositoryId !== ""
    ? { kind: "general", repositoryId }
    : { kind: "general" };
}

export function AgentPage() {
  const { t, formatDateTime } = useI18n();
  const [params, setParams] = useSearchParams();
  const client = useQueryClient();
  const [search, setSearch] = useState("");
  const [origin, setOrigin] = useState<AgentScopeKind | "all">(() => parseOrigin(params.get("origin")));
  const [repository, setRepository] = useState(params.get("repository") ?? "");
  const [status, setStatus] = useState<SessionStatusFilter>(() => parseStatus(params.get("status")));
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [renameError, setRenameError] = useState<Feedback | null>(null);
  const [pageError, setPageError] = useState<Feedback | null>(null);
  const repositories = useRepositories();

  useEffect(() => {
    setOrigin(parseOrigin(params.get("origin")));
    setRepository(params.get("repository") ?? "");
    setStatus(parseStatus(params.get("status")));
  }, [params]);
  const sessions = useQuery({
    queryKey: ["agent-sessions", "all"],
    queryFn: () => listAgentSessions({}),
    refetchInterval: 3000,
  });
  const filtered = useMemo(
    () =>
      (sessions.data?.items ?? []).filter((session) => {
        if (origin !== "all" && session.scope.kind !== origin) return false;
        if (
          repository !== "" &&
          session.scope.repositoryId !== repository
        ) {
          return false;
        }
        if (status !== "all" && session.status !== status) return false;
        const text = `${session.id} ${sessionTitle(session, t)} ${originLabel(session, t)} ${session.scope.repositoryId ?? ""} ${session.model}`.toLowerCase();
        return text.includes(search.trim().toLowerCase());
      }),
    [origin, repository, search, sessions.data, status, t],
  );
  const selectedId = params.get("session");
  const selected =
    filtered.find((session) => session.id === selectedId) ??
    sessions.data?.items.find((session) => session.id === selectedId);
  const selectedSelection = useAgentSessionSelection(
    selected ? JSON.stringify(selected.scope) : "agent:none",
  );
  const remove = useMutation({
    mutationFn: ({ id }: { id: string; scopeKey: string }) =>
      deleteAgentSession(id),
    onSuccess: (_result, variables) => {
      void client.invalidateQueries({ queryKey: ["agent-sessions", "all"] });
      selectedSelection.clearSessionId(variables.id);
      const next = new URLSearchParams(params);
      if (next.get("session") === variables.id) {
        next.delete("session");
        setParams(next);
      }
    },
    onError: (failure: Error) =>
      setPageError({ message: agentMessages.deleteFailed, values: { detail: failure.message } }),
  });
  const create = useMutation({
    mutationFn: () => ensureAgentSession(newSessionScope(origin, repository)),
    onSuccess: (view) => {
      void client.invalidateQueries({ queryKey: ["agent-sessions", "all"] });
      const next = new URLSearchParams(params);
      next.set("session", view.session.id);
      setParams(next);
    },
    onError: (failure: Error) =>
      setPageError({ message: agentMessages.createFailed, values: { detail: failure.message } }),
  });
  const rename = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      updateAgentSession(id, { title }),
    onSuccess: (view) => {
      setEditingSessionId(null);
      setEditingTitle("");
      setRenameError(null);
      client.setQueryData(["agent-session", view.session.id], view);
      void client.invalidateQueries({ queryKey: ["agent-sessions", "all"] });
    },
    onError: (failure: Error) =>
      setRenameError({ message: agentMessages.renameFailed, values: { detail: failure.message } }),
  });
  const startRename = (session: AgentSessionSummary) => {
    setEditingSessionId(session.id);
    setEditingTitle(session.title ?? "");
    setRenameError(null);
  };
  const submitRename = (sessionId: string) => {
    const title = editingTitle.trim();
    if (title.length === 0) {
      setRenameError({ message: agentMessages.titleMustNotBeEmpty });
      return;
    }
    rename.mutate({ id: sessionId, title });
  };

  const canCreateFromOrigin = origin !== "pr" && origin !== "issue" && origin !== "knowledge";
  const select = (session: AgentSessionSummary) => {
    const next = new URLSearchParams(params);
    next.set("session", session.id);
    setParams(next);
  };

  return (
    <section className="agent-page" aria-labelledby="agent-page-heading">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{t(agentMessages.workspaceLabel)}</p>
          <h2 id="agent-page-heading">{t(agentMessages.agentConversations)}</h2>
          <p className="page-subtitle">{t(agentMessages.persistentDescription)}</p>
        </div>
        <button
          className="button-link"
          type="button"
          onClick={() => {
            if (canCreateFromOrigin) create.mutate();
          }}
          disabled={create.isPending || !canCreateFromOrigin}
          title={!canCreateFromOrigin ? t(agentMessages.newConversationUnavailable) : undefined}
        >
          {create.isPending
            ? t(agentMessages.opening)
            : origin === "domain"
              ? t(agentMessages.startDomainUpdate)
              : t(agentMessages.newConversation)}
        </button>
      </div>
      {pageError !== null && (
        <p role="alert" className="agent-error">
          {t(pageError.message, pageError.values)}
        </p>
      )}
      <div className="agent-page-layout">
        <aside
          className="agent-session-list"
          aria-label={t(agentMessages.agentSessions)}
        >
          <div className="agent-session-filters">
            <label>
              {t(agentMessages.search)}
              <input
                aria-label={t(agentMessages.searchConversations)}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t(agentMessages.searchSessions)}
              />
            </label>
            <label>
              {t(agentMessages.origin)}
              <select
                aria-label={t(agentMessages.filterByOrigin)}
                value={origin}
                onChange={(event) => {
                  const next = event.target.value as AgentScopeKind | "all";
                  setOrigin(next);
                  const query = new URLSearchParams(params);
                  query.set("origin", next);
                  setParams(query);
                }}
              >
                {kinds.map((item) => (
                  <option key={item.value} value={item.value}>
                    {t(agentMessages[item.label])}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t(agentMessages.repository)}
              <select
                aria-label={t(agentMessages.filterByRepository)}
                value={repository}
                onChange={(event) => {
                  const value = event.target.value;
                  setRepository(value);
                  const query = new URLSearchParams(params);
                  if (value) query.set("repository", value);
                  else query.delete("repository");
                  setParams(query);
                }}
              >
                <option value="">{t(agentMessages.allRepositories)}</option>
                {repositories.data?.items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t(agentMessages.status)}
              <select
                aria-label={t(agentMessages.filterByStatus)}
                value={status}
                onChange={(event) => {
                  const next = event.target.value as SessionStatusFilter;
                  setStatus(next);
                  const query = new URLSearchParams(params);
                  if (next === "all") query.delete("status");
                  else query.set("status", next);
                  setParams(query);
                }}
              >
                <option value="all">{t(agentMessages.allStatuses)}</option>
                <option value="idle">{t(agentMessages.idle)}</option>
                <option value="running">{t(agentMessages.running)}</option>
                <option value="interrupted">{t(agentMessages.interrupted)}</option>
                <option value="error">{t(agentMessages.error)}</option>
              </select>
            </label>
          </div>
          {sessions.isPending && (
            <p role="status">{t(agentMessages.loadingConversations)}</p>
          )}
          {sessions.isError && <p role="alert">{t(agentMessages.unableLoadConversations, { detail: sessions.error.message })}</p>}
          {!sessions.isPending && filtered.length === 0 && (
            <p role="status">{t(agentMessages.noConversations)}</p>
          )}
          <ul>
            {filtered.map((session) => {
              const title = sessionTitle(session, t);
              const isEditing = editingSessionId === session.id;
              return (
                <li key={session.id}>
                  <div className="agent-session-row-wrap">
                    {isEditing ? (
                      <form
                        className="agent-session-rename"
                        aria-label={t(agentMessages.rename, { title })}
                        onSubmit={(event) => {
                          event.preventDefault();
                          submitRename(session.id);
                        }}
                      >
                        <input
                          aria-label={t(agentMessages.conversationTitle)}
                          value={editingTitle}
                          autoFocus
                          onChange={(event) => setEditingTitle(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") {
                              setEditingSessionId(null);
                              setRenameError(null);
                            }
                          }}
                        />
                        <button
                          type="submit"
                          disabled={rename.isPending}
                          aria-label={t(agentMessages.saveConversationTitle)}
                        >
                          {t(agentMessages.save)}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingSessionId(null);
                            setRenameError(null);
                          }}
                          aria-label={t(agentMessages.cancelConversationRename)}
                        >
                          {t(agentMessages.cancel)}
                        </button>
                      </form>
                    ) : (
                      <button
                        type="button"
                        className={
                          session.id === selectedId
                            ? "agent-session-row active"
                            : "agent-session-row"
                        }
                        onClick={() => select(session)}
                      >
                        <span
                          className={`agent-row-status status-${session.status}`}
                          aria-label={session.status}
                        />
                        <span className="agent-session-row__copy">
                          <strong>{title}</strong>
                          <small>
                            {originLabel(session, t)} · {session.scope.repositoryId ?? t(agentMessages.workspaceLabel)} · {formatDateTime(session.lastUsedAt)}
                          </small>
                        </span>
                        <span className="agent-session-row__model">{session.model}</span>
                      </button>
                    )}
                    {!isEditing && (
                      <span className="agent-session-actions">
                        <button
                          type="button"
                          className="agent-session-rename-button"
                          aria-label={t(agentMessages.rename, { title })}
                          onClick={() => startRename(session)}
                        >
                          ✎
                        </button>
                        <button
                          type="button"
                          className="agent-session-delete"
                          aria-label={t(agentMessages.delete, { title })}
                          onClick={() => {
                            if (window.confirm(t(agentMessages.deleteConversation))) {
                              remove.mutate({
                                id: session.id,
                                scopeKey: JSON.stringify(session.scope),
                              });
                            }
                          }}
                        >
                          ×
                        </button>
                      </span>
                    )}
                  </div>
                  {isEditing && renameError !== null && (
                    <p className="agent-session-rename-error" role="alert">
                      {t(renameError.message, renameError.values)}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </aside>
        <div className="agent-page-surface">
          {selected ? (
            <>
              <div className="agent-page-source">
                <span>
                  {sessionTitle(selected, t)} · {originLabel(selected, t)} · {selected.status}
                </span>
                <Link to={sourceHref(selected)}>{t(agentMessages.openSource)}</Link>
              </div>
              <AgentChatPanel
                scope={selected.scope}
                initialSessionId={selected.id}
                heading={t(agentMessages.agent)}
                panelId="agent-page-chat"
                showCollapseControl={false}
              />
            </>
          ) : (
            <div className="agent-page-empty">
              <span className="settings-tile-icon">✦</span>
              <h3>{t(agentMessages.selectConversation)}</h3>
              <p>{t(agentMessages.continueSameContext)}</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
