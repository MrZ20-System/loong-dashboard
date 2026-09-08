import type { AgentRuntimeEvent } from "@loongboard/agent-runtime";
import type { HarnessNotification } from "@deepseek-ai/dsh-sdk-client";

/**
 * Maps the pinned DSH SDK's real `session.event` wire shape to LoongBoard
 * runtime events. Notifications arrive as
 *
 *   { method: "session.event", params: { sessionId, event: { type, seq, time, data } } }
 *
 * and only the V1 event types below are understood; other methods and event
 * types are ignored by design. `RunResult.finalResponse` is the single source
 * of the completed assistant message, so assistant/message emits nothing.
 *
 * One mapper instance covers one run: tool names are remembered per callId
 * because tool/result events carry no tool name on the wire.
 */
export class DshNotificationMapper {
  private readonly toolNames = new Map<string, string>();

  map(notification: HarnessNotification): AgentRuntimeEvent[] {
    const event = unwrapSessionEvent(notification);
    if (event === null || typeof event.type !== "string") return [];
    switch (event.type) {
      case "assistant/chunk":
        return this.mapTextDelta(event.data);
      case "assistant/message":
        // The completed message is persisted exactly once from
        // RunResult.finalResponse; emitting it here would duplicate it.
        return [];
      case "tool/call":
        return this.mapToolCall(event.data);
      case "tool/result":
        return this.mapToolResult(event.data);
      default:
        // Unknown session event types are not part of the V1 surface.
        return [];
    }
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
