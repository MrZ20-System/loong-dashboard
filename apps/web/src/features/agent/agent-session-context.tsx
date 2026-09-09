import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

type SessionSelections = Record<string, string>;
const AgentSessionSelectionContext = createContext<{
  selections: SessionSelections;
  setSelection: (scopeKey: string, sessionId: string) => void;
  clearSelection: (scopeKey: string, sessionId?: string) => void;
}>({ selections: {}, setSelection: () => undefined, clearSelection: () => undefined });

export function AgentSessionSelectionProvider({ children }: { children: ReactNode }) {
  const [selections, setSelections] = useState<SessionSelections>({});
  const value = useMemo(() => ({
    selections,
    setSelection: (scopeKey: string, sessionId: string) => setSelections((previous) => ({ ...previous, [scopeKey]: sessionId })),
    clearSelection: (scopeKey: string, sessionId?: string) => setSelections((previous) => {
      if (sessionId !== undefined && previous[scopeKey] !== sessionId) return previous;
      if (!(scopeKey in previous)) return previous;
      const next = { ...previous };
      delete next[scopeKey];
      return next;
    }),
  }), [selections]);
  return <AgentSessionSelectionContext.Provider value={value}>{children}</AgentSessionSelectionContext.Provider>;
}

export function useAgentSessionSelection(scopeKey: string) {
  const context = useContext(AgentSessionSelectionContext);
  return {
    sessionId: context.selections[scopeKey],
    setSessionId: (sessionId: string) => context.setSelection(scopeKey, sessionId),
    clearSessionId: (sessionId?: string) => context.clearSelection(scopeKey, sessionId),
  };
}
