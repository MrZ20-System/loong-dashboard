import type { AgentRuntimeEvent } from "@loongboard/agent-runtime";
import type { HarnessNotification } from "@deepseek-ai/dsh-sdk-client";

/**
 * Maps the pinned DSH SDK's real `session.event` wire shape to LoongBoard
 * runtime events. Notifications arrive as
 *
 *   { method: "session.event", params: { sessionId, event: { type, seq, time, data } } }
 *
 * and only the V1 event types below are understood; other methods and event
 * types are ignored by design. The runtime joins durable completion with Host
 * idle before emitting the final assistant message.
 *
 * One mapper instance covers one run: tool names are remembered per callId
 * because tool/result events carry no tool name on the wire.
 */
export class DshNotificationMapper {
  private readonly toolNames = new Map<string, string>();

  map(notification: HarnessNotification): AgentRuntimeEvent[] {
    const lifecycle = this.mapLifecycle(notification);
    if (lifecycle.length > 0) return lifecycle;
    const event = unwrapSessionEvent(notification);
    if (event === null || typeof event.type !== "string") return [];
    switch (event.type) {
      case "assistant/chunk":
        return this.mapTextDelta(event.data);
      case "assistant/message":
        // The completed message is persisted exactly once from
        // the runtime completion boundary; emitting here would duplicate it.
        return [];
      case "tool/call":
        return this.mapToolCall(event.data);
      case "tool/result":
        return this.mapToolResult(event.data);
      default:
        return this.mapNativeActivity(event.type, event.data);
    }
  }

  private mapLifecycle(notification: HarnessNotification): AgentRuntimeEvent[] {
    if (!isRecord(notification.params)) return [];
    if (notification.method === "session.status") {
      const sessionId = stringValue(notification.params.sessionId);
      const status = notification.params.status;
      if (sessionId.length === 0 || (status !== "idle" && status !== "running")) {
        return [];
      }
      return [
        {
          type: "agent.activity",
          kind: "runtime",
          phase: "updated",
          id: sessionId,
          data: { status },
        },
      ];
    }
    if (notification.method === "subagent.started") {
      const parentSessionId = stringValue(notification.params.parentSessionId);
      const childSessionId = stringValue(notification.params.childSessionId);
      if (parentSessionId.length === 0 || childSessionId.length === 0) return [];
      return [
        {
          type: "agent.activity",
          kind: "subagent",
          phase: "started",
          id: childSessionId,
          data: { parentSessionId, childSessionId },
        },
      ];
    }
    if (notification.method === "subagent.finished") {
      const parentSessionId = stringValue(notification.params.parentSessionId);
      const childSessionId = stringValue(notification.params.childSessionId);
      const status = stringValue(notification.params.status);
      if (parentSessionId.length === 0 || childSessionId.length === 0) return [];
      return [
        {
          type: "agent.activity",
          kind: "subagent",
          phase: status === "ok" ? "completed" : "failed",
          id: childSessionId,
          data: {
            parentSessionId,
            childSessionId,
            ...(status.length > 0 ? { status } : {}),
          },
        },
      ];
    }
    return [];
  }

  private mapNativeActivity(type: unknown, data: unknown): AgentRuntimeEvent[] {
    if (typeof type !== "string") return [];
    const slash = type.indexOf("/");
    const prefix = slash === -1 ? type : type.slice(0, slash);
    const suffix = slash === -1 ? "" : type.slice(slash + 1);
    const kind = nativeActivityKind(prefix);
    if (kind === null) return [];
    const record = isRecord(data) ? data : {};
    const phase = nativeActivityPhase(suffix);
    const id = firstString(record.callId, record.commandId, record.jobId, record.id);
    const title = firstString(record.name, record.title, record.command);
    const summary = firstString(record.text, record.message, record.summary);
    const details: Record<string, unknown> = {};
    if (typeof record.status === "string") details.status = record.status;
    if (typeof record.exitCode === "number") details.exitCode = record.exitCode;
    if (typeof record.isError === "boolean") details.isError = record.isError;
    return [
      {
        type: "agent.activity",
        kind,
        phase,
        ...(id.length > 0 ? { id } : {}),
        ...(title.length > 0 ? { title } : {}),
        ...(summary.length > 0 ? { summary } : {}),
        ...(Object.keys(details).length > 0 ? { data: details } : {}),
      },
    ];
  }

  private mapTextDelta(data: unknown): AgentRuntimeEvent[] {
    if (!isRecord(data)) return [];
    const chunk = data.chunk;
    if (!isRecord(chunk) || chunk.type !== "text-delta") return [];
    const text = typeof chunk.text === "string" ? chunk.text : "";
    return text.length > 0 ? [{ type: "assistant.delta", text }] : [];
  }

  private mapToolCall(data: unknown): AgentRuntimeEvent[] {
    if (!isRecord(data)) return [];
    const callId = typeof data.callId === "string" ? data.callId : "";
    const name = typeof data.name === "string" ? data.name : "";
    if (callId.length === 0 || name.length === 0) return [];
    this.toolNames.set(callId, name);
    const argumentsText = typeof data.arguments === "string" ? data.arguments : "";
    return [
      {
        type: "tool.started",
        callId,
        name,
        ...(argumentsText.length > 0 ? { summary: argumentsText } : {}),
      },
    ];
  }

  private mapToolResult(data: unknown): AgentRuntimeEvent[] {
    if (!isRecord(data)) return [];
    const message = data.message;
    if (!isRecord(message)) return [];
    const source = message.source;
    if (!isRecord(source)) return [];
    const callId = typeof source.callId === "string" ? source.callId : "";
    if (callId.length === 0) return [];
    // tool/result carries no name; recover it from the paired tool/call of
    // this run, keeping the previous placeholder for unmatched results.
    const name = this.toolNames.get(callId) ?? "tool";
    const isError = data.error !== undefined || toolResultBlockError(message.content);
    return [{ type: "tool.completed", callId, name, isError }];
  }
}

function unwrapSessionEvent(
  notification: HarnessNotification,
): { type: unknown; data: unknown } | null {
  if (notification.method !== "session.event" || !isRecord(notification.params)) {
    return null;
  }
  const event = notification.params.event;
  if (!isRecord(event)) return null;
  return { type: event.type, data: event.data };
}

function toolResultBlockError(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some(
    (block) =>
      isRecord(block) && block.type === "tool-result" && block.isError === true,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

function nativeActivityKind(
  prefix: string,
): "reasoning" | "command" | "job" | "subagent" | "plan" | "approval" | "workspace" | "runtime" | null {
  switch (prefix) {
    case "reasoning":
    case "thinking":
      return "reasoning";
    case "command":
    case "shell":
      return "command";
    case "job":
      return "job";
    case "subagent":
      return "subagent";
    case "plan":
      return "plan";
    case "approval":
      return "approval";
    case "workspace":
      return "workspace";
    case "runtime":
      return "runtime";
    default:
      return null;
  }
}

function nativeActivityPhase(
  suffix: string,
): "started" | "updated" | "completed" | "failed" {
  if (suffix.includes("fail") || suffix.includes("error")) return "failed";
  if (suffix.includes("start") || suffix === "begin") return "started";
  if (suffix.includes("complete") || suffix.includes("finish") || suffix === "end") {
    return "completed";
  }
  return "updated";
}
