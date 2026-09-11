import type { AgentRuntimeEvent as ContractEvent } from "@loongboard/contracts";
import type { FastifyReply } from "fastify";

/** One live HTTP connection subscribed to a normalized session event stream. */
interface SseConnection {
  readonly reply: FastifyReply;
  closed: boolean;
}

function interactionKey(sessionId: string, requestId: string): string {
  return `${sessionId}\u0000${requestId}`;
}

/**
 * Session event fan-out and the small amount of ephemeral interaction state
 * needed to suppress a runtime echo after a response was acknowledged.
 *
 * The hub deliberately only sees product-normalized events. DSH transport
 * notifications stay inside the runtime adapter and never cross this boundary.
 */
export class AgentEventHub {
  private readonly subscribers = new Map<string, Set<SseConnection>>();
  private readonly emittedInteractionResolutions = new Set<string>();

  subscribe(sessionId: string, reply: FastifyReply): () => void {
    const connection: SseConnection = { reply, closed: false };
    const set = this.subscribers.get(sessionId) ?? new Set<SseConnection>();
    set.add(connection);
    this.subscribers.set(sessionId, set);
    return () => {
      connection.closed = true;
      set.delete(connection);
      if (set.size === 0) this.subscribers.delete(sessionId);
    };
  }

  broadcast(sessionId: string, event: ContractEvent): void {
    const set = this.subscribers.get(sessionId);
    if (set === undefined || set.size === 0) return;
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const connection of set) {
      if (connection.closed) continue;
      try {
        connection.reply.raw.write(payload);
      } catch {
        connection.closed = true;
      }
    }
  }

  markInteractionResolution(sessionId: string, requestId: string): void {
    this.emittedInteractionResolutions.add(interactionKey(sessionId, requestId));
  }

  forgetInteractionResolution(sessionId: string, requestId: string): void {
    this.emittedInteractionResolutions.delete(interactionKey(sessionId, requestId));
  }

  /** Return true when the event is the runtime echo of our own response. */
  consumeInteractionResolution(sessionId: string, requestId: string): boolean {
    return this.emittedInteractionResolutions.delete(interactionKey(sessionId, requestId));
  }

  clearInteractionResolutions(sessionId: string): void {
    const prefix = `${sessionId}\u0000`;
    for (const key of this.emittedInteractionResolutions) {
      if (key.startsWith(prefix)) this.emittedInteractionResolutions.delete(key);
    }
  }

  /** Close all subscribers and drop interaction state for one deleted session. */
  clearSession(sessionId: string): void {
    this.clearInteractionResolutions(sessionId);
    const set = this.subscribers.get(sessionId);
    if (set === undefined) return;
    for (const connection of set) {
      connection.closed = true;
      try {
        connection.reply.raw.end();
      } catch {
        // The socket may already be gone.
      }
    }
    this.subscribers.delete(sessionId);
  }

  async close(): Promise<void> {
    for (const set of this.subscribers.values()) {
      for (const connection of set) {
        connection.closed = true;
        try {
          connection.reply.raw.end();
        } catch {
          // The socket may already be gone during shutdown.
        }
      }
    }
    this.subscribers.clear();
    this.emittedInteractionResolutions.clear();
  }
}
