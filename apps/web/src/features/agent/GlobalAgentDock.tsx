import { useState } from "react";
import { useLocation } from "react-router-dom";
import { AgentChatPanel } from "../../agent-chat";
import type { AgentScope } from "@loongboard/contracts";
import { useAgentSessionSelection } from "./agent-session-context";

function pageScope(pathname: string): AgentScope {
  const match = pathname.match(/^\/repositories\/([^/]+)/);
  const repositoryId = match?.[1] ? decodeURIComponent(match[1]) : undefined;
  const pr = pathname.match(/\/pulls\/(\d+)/);
  const issue = pathname.match(/\/issues\/(\d+)/);
  if (repositoryId && pr) return { kind: "general", repositoryId };
  if (repositoryId && issue) return { kind: "issue", repositoryId, issueNumber: Number(issue[1]) };
  if (pathname.startsWith("/knowledge/")) return { kind: "knowledge", knowledgeDocumentId: decodeURIComponent(pathname.split("/")[2] ?? "") };
  if (repositoryId) return { kind: "repository", repositoryId };
  return { kind: "general" };
}

export function GlobalAgentDock() {
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const scope = pageScope(location.pathname);
  const scopeKey = JSON.stringify(scope);
  const { sessionId: existingSessionId } = useAgentSessionSelection(scopeKey);
  if (location.pathname.startsWith("/agent") || location.pathname.match(/\/pulls\/\d+$/) !== null) return null;
  return <div className={`global-agent-dock${open ? " global-agent-dock--open" : ""}`}><button type="button" className="global-agent-launcher" onClick={() => setOpen((value) => !value)} aria-label={open ? "Close Agent dock" : "Open Agent dock"} aria-expanded={open}><span aria-hidden="true">✦</span><span>Agent</span></button>{open && <div className="global-agent-dock__panel"><button type="button" className="global-agent-dock__close" onClick={() => setOpen(false)} aria-label="Close Agent dock">×</button><AgentChatPanel scope={scope} initialSessionId={existingSessionId} heading="Agent" panelId="global-agent-dock" /></div>}</div>;
}
