import type { AgentRuntimeEvent } from "@loongboard/contracts";

export type { AgentRuntimeEvent, AgentScope } from "@loongboard/contracts";

/** Everything the runtime needs to spawn/attach one LoongBoard session. */
export interface AgentSessionSpec {
  sessionId: string;
  /** Working directory for the agent (PR worktree or repository root). */
  workspacePath: string;
  provider: string;
  model: string;
  reasoningEffort?: string;
  maxTokens?: number;
  /** Per-session isolated harness home (plan 13.2). */
  dshHomePath: string;
  /** Reuse an existing runtime session id so context survives restarts. */
  runtimeSessionId?: string;
}

/** The runtime provider contract (plan 13.1) with an added close(). */
export interface AgentRuntime {
  run(
    spec: AgentSessionSpec,
    prompt: string,
  ): AsyncIterable<AgentRuntimeEvent>;
  /** Terminate the process owning this session; later runs resume it. */
  stop(sessionId: string): Promise<void>;
  close(): Promise<void>;
  /**
   * Optional opaque runtime-side session id for `sessionId`, available after
   * the first successful run. Persisting it lets a later run resume model
   * context after the process was shut down for idleness (plan 13.3.10).
   */
  runtimeSessionId?(sessionId: string): string | null;
}

export interface AgentRuntimeHealth {
  status: "ok" | "error";
  activeSessions: number;
  message?: string;
}

/**
 * Vendor-neutral supervisor: keeps one runtime per session, tracks running
 * state, stops sessions on demand, and closes idle runtimes after
 * `idleCloseMs` of no activity (plan 19.4 default 20 minutes). Runtime
 * instances are created lazily by the injected factory, so the core has no
 * DSH knowledge.
 */
export class AgentRuntimeHost {
  private readonly runtimes = new Map<string, AgentRuntime>();
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly active = new Set<string>();
  private readonly factory: (spec: AgentSessionSpec) => AgentRuntime;

  constructor(
    factory: (spec: AgentSessionSpec) => AgentRuntime,
    private readonly idleCloseMs = 20 * 60 * 1000,
  ) {
    this.factory = factory;
  }

  runtime(sessionId: string): AgentRuntime | undefined {
    return this.runtimes.get(sessionId);
  }

  /** Return the live runtime for a session, creating it on first use. */
  ensure(spec: AgentSessionSpec): AgentRuntime {
    const existing = this.runtimes.get(spec.sessionId);
    if (existing !== undefined) return existing;
    const runtime = this.factory(spec);
    this.runtimes.set(spec.sessionId, runtime);
    return runtime;
  }

  isRunning(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  beginRun(sessionId: string): void {
    this.active.add(sessionId);
    this.clearIdle(sessionId);
  }

  endRun(sessionId: string): void {
    this.active.delete(sessionId);
    const runtime = this.runtimes.get(sessionId);
    if (runtime !== undefined && this.idleCloseMs > 0) {
      this.clearIdle(sessionId);
      const timer = setTimeout(() => {
        void this.stop(sessionId).catch(() => undefined);
      }, this.idleCloseMs);
      this.idleTimers.set(sessionId, timer);
    }
  }

  /** Stop the session's process now (cancel semantics, plan 13.4). */
  async stop(sessionId: string): Promise<void> {
    this.active.delete(sessionId);
    this.clearIdle(sessionId);
    const runtime = this.runtimes.get(sessionId);
    if (runtime !== undefined) {
      await runtime.stop(sessionId);
    }
  }

  /** Close every live runtime (server shutdown). */
  async close(): Promise<void> {
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    const runtimes = [...this.runtimes.values()];
    this.runtimes.clear();
    this.active.clear();
    await Promise.all(runtimes.map((runtime) => runtime.close()));
  }

  activeCount(): number {
    return this.active.size;
  }

  private clearIdle(sessionId: string): void {
    const timer = this.idleTimers.get(sessionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.idleTimers.delete(sessionId);
    }
  }
}
