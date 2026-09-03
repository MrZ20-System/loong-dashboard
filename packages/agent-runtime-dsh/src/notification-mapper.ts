import type { AgentRuntimeEvent } from "@loongboard/agent-runtime";
import type { HarnessNotification } from "@deepseek-ai/dsh-sdk-client";

/**
 * Best-effort mapping from SDK wire notifications to the LoongBoard runtime
 * event vocabulary (plan 13.1). The pinned pre-release SDK emits every
 * session-log event as `session.event` with the payload nested under
 * `params.event`, so this mapper understands both that nested shape and flat
 * top-level params. The authoritative assistant text comes from
 * `RunResult.finalResponse`, which the SDK guarantees; assistant/message
 * events only produce deltas here so the persisted transcript stays
 * deduplicated.
 */
export function mapNotification(
  notification: HarnessNotification,
): AgentRuntimeEvent[] {
  const params = notification.params ?? {};
  const inner =
    params.event !== null &&
    typeof params.event === "object" &&
    !Array.isArray(params.event)
      ? (params.event as Record<string, unknown>)
      : params;
  const events: AgentRuntimeEvent[] = [];

  if (notification.method === "session.event") {
    return mapSessionEvent(inner);
  }
  if (notification.method === "session.status") {
    // The supervisor derives idle/running from its own run lifecycle; a
    // status echo here would duplicate it.
    return [];
  }

  const text = extractText(params);
  if (text !== null && text.length > 0) {
    events.push({ type: "assistant.delta", text });
  }
  const tool = extractTool(params, notification.method);
  if (tool !== null) events.push(toolEvent(tool));
  return events;
}

function mapSessionEvent(event: Record<string, unknown>): AgentRuntimeEvent[] {
  switch (event.type) {
    case "assistant/chunk": {
      const text = extractText(
        event.chunk !== null && typeof event.chunk === "object"
          ? (event.chunk as Record<string, unknown>)
          : {},
      );
      return text !== null && text.length > 0
        ? [{ type: "assistant.delta", text }]
        : [];
    }
    case "tool/call": {
      const tool = extractTool(event);
      return tool !== null ? [toolEvent({ ...tool, done: false })] : [];
    }
    case "tool/result": {
      const tool = extractTool(event);
      if (tool === null) {
        // Real tool/result events carry no tool name; the run's transcript
        // already recorded the name from its paired tool/call.
        const callId =
          typeof event.callId === "string"
            ? event.callId
            : typeof event.id === "string"
              ? event.id
              : "tool";
        return [
          {
            type: "tool.completed",
            callId,
            name: "tool",
            isError: event.error !== undefined,
          },
        ];
      }
      const isError = tool.isError || event.error !== undefined;
      return [
        {
          type: "tool.completed",
          callId: tool.callId,
          name: tool.name,
          ...(tool.summary !== undefined ? { summary: tool.summary } : {}),
          isError,
        },
      ];
    }
    default: {
      const text = extractText(event);
      const tool = extractTool(event);
      const events: AgentRuntimeEvent[] = [];
      if (text !== null && text.length > 0) {
        events.push({ type: "assistant.delta", text });
      }
      if (tool !== null) events.push(toolEvent(tool));
      return events;
    }
  }
}

function toolEvent(tool: {
  callId: string;
  name: string;
  summary?: string;
  done: boolean;
  isError: boolean;
}): AgentRuntimeEvent {
  const base = {
    callId: tool.callId,
    name: tool.name,
    ...(tool.summary !== undefined ? { summary: tool.summary } : {}),
  };
  return tool.done
    ? { type: "tool.completed", ...base, isError: tool.isError }
    : { type: "tool.started", ...base };
}

/** Pull a text-ish value out of known payload shapes; null when absent. */
function extractText(params: Record<string, unknown>): string | null {
  if (typeof params.text === "string" && params.text.length > 0) {
    return params.text;
  }
  if (typeof params.delta === "string" && params.delta.length > 0) {
    return params.delta;
  }
  if (typeof params.content === "string" && params.content.length > 0) {
    return params.content;
  }
  const content = params.content;
  if (Array.isArray(content)) {
    const parts = content
      .map((block: unknown) => {
        if (block === null || typeof block !== "object") return null;
        const record = block as Record<string, unknown>;
        if (typeof record.text === "string") return record.text;
        return null;
      })
      .filter((value): value is string => value !== null);
    if (parts.length > 0) return parts.join("\n");
  }
  // A message block may wrap its blocks under `content` (AssistantMessage).
  const message = params.message;
  if (message !== null && typeof message === "object") {
    return extractText(message as Record<string, unknown>);
  }
  return null;
}

function extractTool(
  params: Record<string, unknown>,
  method?: string,
): {
  callId: string;
  name: string;
  summary?: string;
  done: boolean;
  isError: boolean;
} | null {
  const name =
    typeof params.toolName === "string"
      ? params.toolName
      : typeof params.name === "string"
        ? params.name
        : null;
  if (name === null) return null;
  const callId =
    typeof params.callId === "string"
      ? params.callId
      : typeof params.id === "string"
        ? params.id
        : `${name}:${Math.random().toString(36).slice(2, 8)}`;
  const summary =
    typeof params.summary === "string"
      ? params.summary
      : typeof params.arguments === "string" && params.arguments.length > 0
        ? params.arguments
        : undefined;
  const state = typeof params.state === "string" ? params.state : null;
  const methodSaysDone =
    method !== undefined && /complete|finish|result/i.test(method);
  const done =
    state !== null
      ? ["done", "completed", "finished"].includes(state)
      : params.result !== undefined ||
        params.error !== undefined ||
        methodSaysDone;
  const isError =
    typeof params.isError === "boolean"
      ? params.isError
      : params.error !== undefined;
  return { callId, name, summary, done, isError };
}
