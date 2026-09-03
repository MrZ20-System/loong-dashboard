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
} from "./agent-chat-client";
import { MarkdownView } from "./markdown";

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
}

function emptyLive(): LiveTurn {
  return { text: "", tools: [] };
}

/**
 * Reusable right-rail Agent chat (plan 18.2/18.3/14): scope -> default
 * session, persisted transcript, live streaming over SSE, cancel, and the PR
 * worktree revision banner (plan 12.5).
 */
export function AgentChatPanel({
  scope,
  heading = "Agent",
}: {
  scope: AgentScope;
  heading?: string;
}) {
  const queryClient = useQueryClient();
  const scopeKey = useMemo(() => JSON.stringify(scope), [scope]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const eventCleanup = useRef<(() => void) | null>(null);

  const ensure = useMutation({
    mutationFn: (body: { scope: AgentScope }) => ensureAgentSession(body.scope),
    onSuccess: (view) => setCurrentSessionId(view.session.id),
    onError: (failure: Error) => setError(failure.message),
  });

  useEffect(() => {
    eventCleanup.current?.();
    eventCleanup.current = null;
    setCurrentSessionId(null);
    setLive(null);
    setError(null);
    setMessage(null);
    ensure.mutate({ scope });
    // The scope object is stable within a page; re-open only when it changes.
  }, [scopeKey]);

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
              return { text: previous?.text ?? "", tools: [...tools, { callId: event.callId, name: event.name, done: false, isError: false }] };
            });
            break;
          case "tool.completed":
            setLive((previous) => ({
              text: previous?.text ?? "",
              tools: (previous?.tools ?? []).map((tool) =>
                tool.callId === event.callId
                  ? { ...tool, done: true, isError: event.isError }
                  : tool,
              ),
            }));
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
  const historyItems = (history.data?.items ?? []).filter(
    (item) => item.id !== currentSessionId,
  );
  const revisionMismatch =
    session.data !== undefined &&
    session.data.targetRevision !== null &&
    session.data.workspaceRevision !== null &&
    session.data.targetRevision !== session.data.workspaceRevision;

  const send = () => {
    const content = prompt.trim();
    if (content.length === 0 || currentSessionId === null || running) return;
    submit.mutate(content);
  };

  return (
    <aside className={`agent-panel${collapsed ? " collapsed" : ""}`} aria-label={heading}>
      <header className="agent-panel-header">
        <h3>{heading}</h3>
        <div className="agent-panel-actions">
          {running && (
            <button type="button" className="agent-stop" onClick={() => stop.mutate()} disabled={stop.isPending}>
              Stop
            </button>
          )}
          <button type="button" aria-label={collapsed ? "Expand chat" : "Collapse chat"} onClick={() => setCollapsed((value) => !value)}>
            {collapsed ? "◂" : "▸"}
          </button>
        </div>
      </header>
      {!collapsed && (
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
                <button type="button" disabled={running || syncWorkspace.isPending} onClick={() => syncWorkspace.mutate()}>
                  {syncWorkspace.isPending ? "Syncing…" : "Sync workspace"}
                </button>
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
                {live.text.length > 0 && (
                  <article className="agent-message agent-role-assistant">
                    <MarkdownView text={live.text} />
                  </article>
                )}
                {live.text.length === 0 && live.tools.length === 0 && (
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
            <textarea
              aria-label="Message the agent"
              value={prompt}
              rows={3}
              placeholder="Ask the agent…"
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) send();
              }}
            />
            <div className="agent-composer-actions">
              <button type="submit" disabled={prompt.trim().length === 0 || currentSessionId === null || running || submit.isPending}>
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
