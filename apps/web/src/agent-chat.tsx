import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentScope, AgentSessionSummary } from "@loongboard/contracts";
import {
  cancelAgentTurn,
  connectAgentEvents,
  ensureAgentSession,
  fetchAgentMessages,
  fetchAgentSession,
  listAgentSessions,
  sendAgentMessage,
  syncAgentWorkspace,
  updateAgentSession,
  respondAgentInteraction,
} from "./agent-chat-client";
import { MarkdownView } from "./markdown";
import { PanelCollapseButton } from "./components/pr/ResizableSidePanel";
import { fetchAgentRuntimeSettings } from "./settings-client";
import type {
  AgentRuntimeCommandCapability,
  AgentRuntimeModelCapability,
} from "@loongboard/contracts";
import { useAgentSessionSelection } from "./features/agent/agent-session-context";

interface LiveTool {
  callId: string;
  name: string;
  done: boolean;
  isError: boolean;
}

/** One-turn live buffer updated only by SSE while a turn runs. */
interface LiveTurn {
  text: string;
  tools: LiveTool[];
  activities: Array<{ id: string; kind: string; phase: string; title?: string; summary?: string }>;
  interactions: Array<{ requestId: string; title: string; description?: string; options: Array<{ id: string; label: string }>; resolved: boolean }>;
}

function emptyLive(): LiveTurn {
  return { text: "", tools: [], activities: [], interactions: [] };
}

/**
 * Reusable right-rail Agent chat (plan 18.2/18.3/14): scope -> default
 * session, persisted transcript, live streaming over SSE, cancel, and the PR
 * worktree revision banner (plan 12.5).
 */
export function AgentChatPanel({
  scope,
  initialSessionId,
  heading = "Agent",
  collapsed,
  onToggleCollapsed,
  panelId,
  showCollapseControl = true,
}: {
  scope: AgentScope;
  /** Existing session to open. Supplying this prevents navigation from creating a new chat. */
  initialSessionId?: string;
  heading?: string;
  /** Optional controlled collapsed state for layouts whose grid shrinks the rail. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  panelId?: string;
  showCollapseControl?: boolean;
}) {
  const queryClient = useQueryClient();
  const scopeKey = useMemo(() => JSON.stringify(scope), [scope]);
  const selection = useAgentSessionSelection(scopeKey);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [commandMenuIndex, setCommandMenuIndex] = useState(0);
  const [commandMenuDismissed, setCommandMenuDismissed] = useState(false);
  const [internalCollapsed, setInternalCollapsed] = useState(false);
  const isCollapsed = collapsed ?? internalCollapsed;
  const toggleCollapsed = () => {
    if (onToggleCollapsed !== undefined) onToggleCollapsed();
    else setInternalCollapsed((value) => !value);
  };
  const eventCleanup = useRef<(() => void) | null>(null);
  const activeScopeRef = useRef(scopeKey);
  activeScopeRef.current = scopeKey;
  const capabilities = useQuery({ queryKey: ["agent-runtime-capabilities"], queryFn: fetchAgentRuntimeSettings, staleTime: 30_000 });

  const ensure = useMutation({
    mutationFn: (body: { scope: AgentScope }) => ensureAgentSession(body.scope),
    onSuccess: (view) => { if (activeScopeRef.current !== scopeKey) return; setCurrentSessionId(view.session.id); selection.setSessionId(view.session.id); },
    onError: (failure: Error) => setError(failure.message),
  });

  useEffect(() => {
    eventCleanup.current?.();
    eventCleanup.current = null;
    setCurrentSessionId(initialSessionId ?? null);
    if (initialSessionId !== undefined) selection.setSessionId(initialSessionId);
    setLive(null);
    setError(null);
    setMessage(null);
    if (initialSessionId === undefined) {
      const selectedId = selection.sessionId;
      if (selectedId !== undefined) setCurrentSessionId(selectedId);
      else ensure.mutate({ scope });
    }
    // The scope object is stable within a page; re-open only when it changes.
  }, [scopeKey, initialSessionId, selection.sessionId]);

  const session = useQuery({
    queryKey: ["agent-session", currentSessionId],
    enabled: currentSessionId !== null,
    queryFn: ({ signal }) =>
      fetchAgentSession(currentSessionId as string).then((view) => {
        // Honor the shared signal for cancellation-sensitive clients.
        void signal;
        return view;
      }),
    refetchInterval: (query) =>
      query.state.data?.session.status === "running" ? 1500 : false,
  });

  const history = useQuery({
    queryKey: ["agent-sessions", scopeKey, "history"],
    enabled:
      scope.kind === "pr" &&
      scope.repositoryId !== undefined &&
      scope.prNumber !== undefined,
    queryFn: () =>
      listAgentSessions({
        scopeType: "pr",
        repositoryId: scope.kind === "pr" ? scope.repositoryId : undefined,
        prNumber: scope.kind === "pr" ? scope.prNumber : undefined,
      }),
  });

  const messages = useQuery({
    queryKey: ["agent-messages", currentSessionId],
    enabled: currentSessionId !== null,
    queryFn: () => fetchAgentMessages(currentSessionId as string),
    refetchInterval: (query) => {
      const status = session.data?.session.status;
      return status === "running" ? 1500 : false;
    },
  });

  const status = session.data?.session.status ?? "idle";
  const running = status === "running";

  useEffect(() => {
    if (currentSessionId === null || running === false) return;
    if (typeof EventSource === "undefined") return;
    setLive(emptyLive());
    eventCleanup.current = connectAgentEvents(
      currentSessionId,
      (event) => {
        switch (event.type) {
          case "assistant.delta":
            setLive((previous) => ({
              text: (previous?.text ?? "") + event.text,
              tools: previous?.tools ?? [],
              activities: previous?.activities ?? [],
              interactions: previous?.interactions ?? [],
            }));
            break;
          case "assistant.completed":
            setLive(null);
            void queryClient.invalidateQueries({ queryKey: ["agent-messages", currentSessionId] });
            break;
          case "tool.started":
            setLive((previous) => {
              const tools = (previous?.tools ?? []).filter(
                (tool) => tool.callId !== event.callId,
              );
              return { text: previous?.text ?? "", tools: [...tools, { callId: event.callId, name: event.name, done: false, isError: false }], activities: previous?.activities ?? [], interactions: previous?.interactions ?? [] };
            });
            break;
          case "tool.completed":
            setLive((previous) => ({
              text: previous?.text ?? "",
              activities: previous?.activities ?? [],
              interactions: previous?.interactions ?? [],
              tools: (previous?.tools ?? []).map((tool) =>
                tool.callId === event.callId
                  ? { ...tool, done: true, isError: event.isError }
                  : tool,
              ),
            }));
            break;
          case "agent.activity":
            setLive((previous) => ({ text: previous?.text ?? "", tools: previous?.tools ?? [], interactions: previous?.interactions ?? [], activities: [...(previous?.activities ?? []).filter((item) => item.id !== (event.id ?? event.kind)), { id: event.id ?? `${event.kind}-${Date.now()}`, kind: event.kind, phase: event.phase, title: event.title, summary: event.summary }] }));
            break;
          case "interaction.requested":
            setLive((previous) => ({ text: previous?.text ?? "", tools: previous?.tools ?? [], activities: previous?.activities ?? [], interactions: [...(previous?.interactions ?? []).filter((item) => item.requestId !== event.requestId), { requestId: event.requestId, title: event.title, description: event.description, options: event.options, resolved: false }] }));
            break;
          case "interaction.resolved":
            setLive((previous) => ({ text: previous?.text ?? "", tools: previous?.tools ?? [], activities: previous?.activities ?? [], interactions: (previous?.interactions ?? []).map((item) => item.requestId === event.requestId ? { ...item, resolved: true } : item) }));
            break;
          case "status":
            if (event.status === "idle" || event.status === "stopped") {
              setLive(null);
              void queryClient.invalidateQueries({ queryKey: ["agent-messages", currentSessionId] });
              void queryClient.invalidateQueries({ queryKey: ["agent-session", currentSessionId] });
            }
            break;
          case "error":
            setLive(null);
            setError(event.message);
            break;
          default:
            break;
        }
      },
      (streamError: Error) => setError(streamError.message),
    );
    return () => {
      eventCleanup.current?.();
      eventCleanup.current = null;
    };
  }, [currentSessionId, running]);

  const submit = useMutation({
    mutationFn: (content: string) =>
      sendAgentMessage(currentSessionId as string, content),
    onSuccess: () => {
      setPrompt("");
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["agent-messages", currentSessionId] });
      void queryClient.invalidateQueries({ queryKey: ["agent-session", currentSessionId] });
    },
    onError: (failure: Error) => setError(failure.message),
  });
  const reconfigure = useMutation({
    mutationFn: (patch: { provider?: string; model?: string; reasoningEffort?: string }) => updateAgentSession(currentSessionId as string, patch),
    onSuccess: (view) => { queryClient.setQueryData(["agent-session", currentSessionId], view); setMessage("Session settings updated."); },
    onError: (failure: Error) => setError(failure.message),
  });
  const interaction = useMutation({
    mutationFn: ({ requestId, value }: { requestId: string; value: string }) => respondAgentInteraction(currentSessionId as string, requestId, value),
    onSuccess: (_result, variables) => setLive((previous) => previous === null ? previous : { ...previous, interactions: previous.interactions.map((item) => item.requestId === variables.requestId ? { ...item, resolved: true } : item) }),
    onError: (failure: Error) => setError(failure.message),
  });

  const stop = useMutation({
    mutationFn: () => cancelAgentTurn(currentSessionId as string),
    onSuccess: (view) => {
      setMessage("Turn stopped. Send a new message to continue.");
      queryClient.setQueryData(["agent-session", currentSessionId], view);
      void queryClient.invalidateQueries({ queryKey: ["agent-messages", currentSessionId] });
    },
    onError: (failure: Error) => setError(failure.message),
  });

  const syncWorkspace = useMutation({
    mutationFn: () => syncAgentWorkspace(currentSessionId as string),
    onSuccess: (view) => {
      queryClient.setQueryData(["agent-session", currentSessionId], view);
      setMessage("Workspace synchronized to the PR head revision.");
    },
    onError: (failure: Error) => setError(failure.message),
  });

  const items = messages.data?.items ?? [];
  const currentSession = session.data?.session;
  const runtimeModels = capabilities.data?.capabilities?.models ?? [];
  const models = currentSession !== undefined && !runtimeModels.some((item) => item.id === currentSession.model)
    ? [{ id: currentSession.model, label: currentSession.model, provider: currentSession.provider, reasoningEfforts: [currentSession.reasoningEffort] }, ...runtimeModels]
    : runtimeModels;
  const selectedModel = models.find((item: AgentRuntimeModelCapability) => item.id === (model || currentSession?.model));
  const reasonings = Array.from(new Set([...selectedModel?.reasoningEfforts ?? capabilities.data?.capabilities?.reasoning ?? [], ...(currentSession?.reasoningEffort ? [currentSession.reasoningEffort] : [])]));
  const commands = capabilities.data?.capabilities?.commands ?? [];
  const commandToken = useMemo(() => {
    const match = /(?:^|\s)\/([^\s]*)$/.exec(prompt);
    if (match === null) return null;
    const query = match[1] ?? "";
    return { start: prompt.length - query.length - 1, query };
  }, [prompt]);
  const commandMatches = useMemo(() => {
    const query = commandToken?.query.toLocaleLowerCase() ?? "";
    return commands.filter((item: AgentRuntimeCommandCapability) =>
      `${item.id} ${item.label ?? ""}`.toLocaleLowerCase().includes(query),
    );
  }, [commandToken?.query, commands]);
  const commandMenuOpen = commandToken !== null && !commandMenuDismissed;
  const persistedInteractions = items.reduce<Array<{ requestId: string; title: string; description?: string; options: Array<{ id: string; label: string }>; resolved: boolean }>>((result, item) => {
    const metadata = item.metadataJson;
    if (metadata.type === "interaction.requested" && typeof metadata.requestId === "string" && typeof metadata.title === "string" && Array.isArray(metadata.options)) {
      const options = metadata.options.filter((option): option is { id: string; label: string } => typeof option === "object" && option !== null && typeof (option as { id?: unknown }).id === "string" && typeof (option as { label?: unknown }).label === "string");
      result.push({ requestId: metadata.requestId, title: metadata.title, description: typeof metadata.description === "string" ? metadata.description : undefined, options, resolved: false });
    } else if (metadata.type === "interaction.resolved" && typeof metadata.requestId === "string") {
      const existing = result.find((entry) => entry.requestId === metadata.requestId);
      if (existing) existing.resolved = true;
    }
    return result;
  }, []);
  const historyItems = (history.data?.items ?? []).filter(
    (item) => item.id !== currentSessionId,
  );
  const revisionMismatch =
    session.data !== undefined &&
    session.data.targetRevision !== null &&
    session.data.workspaceRevision !== session.data.targetRevision;

  const send = () => {
    const content = prompt.trim();
    if (
      content.length === 0 ||
      currentSessionId === null ||
      running ||
      revisionMismatch
    ) {
      return;
    }
    submit.mutate(content);
  };
  const chooseCommand = (item: AgentRuntimeCommandCapability) => {
    if (commandToken === null) return;
    const before = prompt.slice(0, commandToken.start);
    setPrompt(`${before}/${item.id} `);
    setCommandMenuDismissed(false);
    setCommandMenuIndex(0);
  };
  const resolvedPanelId = panelId ?? "agent-chat-panel";

  return (
    <aside
      className={`agent-panel${isCollapsed ? " collapsed" : ""}`}
      aria-label={heading}
      id={resolvedPanelId}
    >
      <header className="agent-panel-header">
        <h3>{heading}</h3>
        <div className="agent-panel-actions">
          {running && (
            <button type="button" className="agent-stop" onClick={() => stop.mutate()} disabled={stop.isPending}>
              Stop
            </button>
          )}
          {showCollapseControl && (
            <PanelCollapseButton
              panelId={resolvedPanelId}
              label={heading}
              expanded={!isCollapsed}
              side="right"
              onToggle={toggleCollapsed}
              className="agent-panel-collapse"
            />
          )}
        </div>
      </header>
      {!isCollapsed && (
        <>
          {currentSession !== undefined && session.data !== undefined && (
            <div className="agent-session-meta">
              {session.data.targetRevision !== null && (
                <div className="agent-revision" role="status">
                  <span>Target: {session.data.targetRevision.slice(0, 12)}</span>
                  <span>
                    Workspace: {session.data.workspaceRevision !== null ? `${session.data.workspaceRevision.slice(0, 12)} ${revisionMismatch ? "⚠" : "✓"}` : "—"}
                  </span>
                </div>
              )}
              {session.data.targetRevision !== null && revisionMismatch && (
                <>
                  <p role="alert" className="agent-note">
                    Workspace does not match this PR revision. Sync the workspace
                    before continuing this chat.
                  </p>
                  <button type="button" disabled={running || syncWorkspace.isPending} onClick={() => syncWorkspace.mutate()}>
                    {syncWorkspace.isPending ? "Syncing…" : "Sync workspace"}
                  </button>
                </>
              )}
              <span className={`agent-status agent-status-${currentSession.status}`}>{(currentSession.status)}</span>
            </div>
          )}
          <div className="agent-messages" aria-live="polite">
            {ensure.isPending && <p role="status">Opening session…</p>}
            {error !== null && <p role="alert" className="agent-error">{error}</p>}
            {message !== null && <p role="status" className="agent-note">{message}</p>}
            {!ensure.isPending && !error && items.length === 0 && live === null && (
              <p role="status" className="agent-empty">Ask the agent about this workspace.</p>
            )}
            {items.map((item) => (
              <article key={item.id} className={`agent-message agent-role-${item.role}`}>
                <MarkdownView text={item.contentMarkdown} />
              </article>
            ))}
            {live !== null && (
              <>
                {live.tools.length > 0 && (
                  <ul className="agent-live-tools">
                    {live.tools.map((tool) => (
                      <li key={tool.callId} className={tool.isError ? "tool-error" : tool.done ? "tool-done" : "tool-running"}>
                        {tool.done ? (tool.isError ? "✗" : "✓") : "…"} {tool.name}
                      </li>
                    ))}
                  </ul>
                )}
                {(() => { const interactions = [...live.interactions, ...persistedInteractions.filter((saved) => !live.interactions.some((item) => item.requestId === saved.requestId))]; return interactions.some((item) => !item.resolved) ? <ul className="agent-live-interactions" aria-label="Agent approval requests">{interactions.filter((item) => !item.resolved).map((item) => <li key={item.requestId}><strong>{item.title}</strong>{item.description && <p>{item.description}</p>}<div className="agent-interaction-options">{item.options.map((option) => <button type="button" key={option.id} disabled={!running || interaction.isPending} onClick={() => interaction.mutate({ requestId: item.requestId, value: option.id })}>{option.label}</button>)}</div></li>)}</ul> : null; })()}
                {live.activities.length > 0 && <ul className="agent-live-activities">{live.activities.map((activity) => <li key={activity.id}><span className="agent-activity-kind">{activity.kind}</span><strong>{activity.title ?? activity.phase}</strong>{activity.summary && <small>{activity.summary}</small>}</li>)}</ul>}
                {live.text.length > 0 && (
                  <article className="agent-message agent-role-assistant">
                    <MarkdownView text={live.text} />
                  </article>
                )}
                {live.text.length === 0 && live.tools.length === 0 && live.activities.length === 0 && live.interactions.every((item) => item.resolved) && (
                  <p role="status" className="agent-note">Agent is working…</p>
                )}
              </>
            )}
          </div>
          {historyItems.length > 0 && (
            <div className="agent-history">
              <h4>Chats for this PR</h4>
              <ul>
                {historyItems.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setCurrentSessionId(item.id);
                        setLive(null);
                        setError(null);
                      }}
                    >
                      {item.scope.kind === "pr" && item.scope.targetSha !== undefined
                        ? item.scope.targetSha.slice(0, 10)
                        : item.id}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <form
            className="agent-composer"
            onSubmit={(event) => {
              event.preventDefault();
              send();
            }}
          >
            <div className="agent-composer__input">
              <textarea
                aria-label="Message the agent"
                value={prompt}
                rows={3}
                placeholder="Ask the agent…"
                onChange={(event) => {
                  setPrompt(event.target.value);
                  setCommandMenuDismissed(false);
                  setCommandMenuIndex(0);
                }}
                onKeyDown={(event) => {
                  if (commandMenuOpen && event.key === "Escape") {
                    event.preventDefault();
                    setCommandMenuDismissed(true);
                    return;
                  }
                  if (commandMenuOpen && event.key === "ArrowDown") {
                    event.preventDefault();
                    setCommandMenuIndex((index) => commandMatches.length === 0 ? 0 : (index + 1) % commandMatches.length);
                    return;
                  }
                  if (commandMenuOpen && event.key === "ArrowUp") {
                    event.preventDefault();
                    setCommandMenuIndex((index) => commandMatches.length === 0 ? 0 : (index - 1 + commandMatches.length) % commandMatches.length);
                    return;
                  }
                  if (commandMenuOpen && event.key === "Enter" && !event.metaKey && !event.ctrlKey && commandMatches.length > 0) {
                    event.preventDefault();
                    chooseCommand(commandMatches[commandMenuIndex] ?? commandMatches[0]);
                    return;
                  }
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) send();
                }}
              />
              {commandMenuOpen && (
                <div className="agent-command-menu" role="listbox" aria-label="Runtime commands">
                  {capabilities.isPending ? (
                    <p className="agent-command-menu__empty" role="status">Loading runtime commands…</p>
                  ) : commands.length === 0 ? (
                    <p className="agent-command-menu__empty" role="status">No runtime commands available.</p>
                  ) : commandMatches.length === 0 ? (
                    <p className="agent-command-menu__empty" role="status">No matching runtime commands.</p>
                  ) : (
                    commandMatches.map((item: AgentRuntimeCommandCapability, index: number) => (
                      <button
                        type="button"
                        role="option"
                        aria-selected={index === commandMenuIndex}
                        className="agent-command-menu__item"
                        key={item.id}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => chooseCommand(item)}
                      >
                        <strong>/{item.id}</strong>
                        {item.label !== undefined && item.label !== item.id && <span>{item.label}</span>}
                        {item.description !== undefined && <small>{item.description}</small>}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
            <div className="agent-composer-actions">
              <label className="agent-composer-select">Model<select aria-label="Agent model" value={model || currentSession?.model || ""} onChange={(event) => { const item = models.find((candidate: AgentRuntimeModelCapability) => candidate.id === event.target.value); setModel(event.target.value); setReasoning(""); if (currentSessionId !== null && item) reconfigure.mutate({ model: item.id, provider: item.provider, ...(item.reasoningEfforts[0] ? { reasoningEffort: item.reasoningEfforts[0] } : {}) }); }} disabled={running || reconfigure.isPending}><option value="">Runtime default</option>{models.map((item: AgentRuntimeModelCapability) => <option key={item.id} value={item.id}>{item.label ?? item.id} · {item.provider}</option>)}</select></label>
              <label className="agent-composer-select">Reasoning<select aria-label="Agent reasoning" value={reasoning || currentSession?.reasoningEffort || ""} onChange={(event) => { setReasoning(event.target.value); if (currentSessionId !== null) reconfigure.mutate({ reasoningEffort: event.target.value }); }} disabled={running || reconfigure.isPending}><option value="">Runtime default</option>{reasonings.map((item: string) => <option key={item} value={item}>{item}</option>)}</select></label>
              <button type="submit" disabled={prompt.trim().length === 0 || currentSessionId === null || running || revisionMismatch || submit.isPending}>
                {submit.isPending ? "Sending…" : "Send"}
              </button>
              <span className="agent-composer-hint">Ctrl/⌘ + Enter to send</span>
            </div>
          </form>
        </>
      )}
    </aside>
  );
}

export type { AgentScope, AgentSessionSummary };
