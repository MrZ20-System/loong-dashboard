import { useState } from "react";
import { useLocation } from "react-router-dom";
import { AgentChatPanel } from "../../agent-chat";
import type { AgentScope } from "@loongboard/contracts";
import { useAgentSessionSelection } from "./agent-session-context";
import { useI18n } from "../../i18n";
import { agentMessages } from "./messages";

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
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const scope = pageScope(location.pathname);
  const scopeKey = JSON.stringify(scope);
  const { sessionId: existingSessionId } = useAgentSessionSelection(scopeKey);
  if (location.pathname.startsWith("/agent") || location.pathname.match(/\/pulls\/\d+$/) !== null) return null;
  const agentLabel = t(agentMessages.agent);
  return <div className={`global-agent-dock${open ? " global-agent-dock--open" : ""}`}>
    {!open && <button type="button" className="global-agent-launcher" onClick={() => setOpen(true)} aria-label={t(agentMessages.openDock)} aria-expanded={false}><span aria-hidden="true">✦</span><span>{agentLabel}</span></button>}
    {open && <div className="global-agent-dock__panel">
      <button type="button" className="global-agent-dock__close" onClick={() => setOpen(false)} aria-label={t(agentMessages.closeDock)}>×</button>
      <AgentChatPanel scope={scope} initialSessionId={existingSessionId} heading={agentLabel} panelId="global-agent-dock" showCollapseControl={false} />
    </div>}
  </div>;
}
