import type {
  AgentRuntimeCapabilities,
  AgentRuntimeEvent,
} from "@loongboard/contracts";

export type {
  AgentRuntimeCapabilities,
  AgentRuntimeCommandCapability,
  AgentRuntimeEvent,
  AgentRuntimeModelCapability,
  AgentRuntimeProviderCapability,
  AgentScope,
} from "@loongboard/contracts";

/**
 * A runtime-owned title projection.  This deliberately contains no vendor
 * event or SDK type; adapters may omit `source` when the native list API only
 * exposes the projected title text.
 */
export interface AgentRuntimeTitle {
  title: string;
  source?: "fallback" | "provider" | "user";
}

/** Everything the runtime needs to spawn/attach one LoongBoard session. */
export interface AgentSessionSpec {
  sessionId: string;
  /** Working directory for the agent (PR worktree or repository root). */
  workspacePath: string;
  provider: string;
  model: string;
  reasoningEffort?: string;
  maxTokens?: number;
  /** Per-session isolated harness home. */
  dshHomePath: string;
  /** Reuse an existing runtime session id so context survives restarts. */
  runtimeSessionId?: string;
}

/** The runtime provider contract, including explicit close(). */
export interface AgentRuntime {
  run(
    spec: AgentSessionSpec,
    prompt: string,
  ): AsyncIterable<AgentRuntimeEvent>;
  /** Terminate the process owning this session; later runs resume it. */
  stop(sessionId: string): Promise<void>;
  close(): Promise<void>;
  /** Resolve a runtime-owned approval or other interaction request. */
  respond?(sessionId: string, requestId: string, value: unknown): Promise<void>;
  /**
   * Optional opaque runtime-side session id for `sessionId`, available after
   * the first successful run. Persisting it lets a later run resume model
   * context after the process was shut down for idleness.
   */
  runtimeSessionId?(sessionId: string): string | null;
  /** Read a title already accepted by the runtime, when supported. */
  getTitle?(sessionId: string): Promise<AgentRuntimeTitle | null>;
  /** Explicitly rename an existing runtime session, when supported. */
  rename?(sessionId: string, title: string): Promise<AgentRuntimeTitle>;
  /** Discover capabilities through the runtime's public API, when available. */
  discoverCapabilities?(spec: AgentSessionSpec): Promise<AgentRuntimeCapabilities>;
}

export interface AgentRuntimeHealth {
  status: "ok" | "error";
  activeSessions: number;
  message?: string;
}

/**
 * Vendor-neutral supervisor: keeps one runtime per session, tracks running
 * state, stops sessions on demand, and closes idle runtimes after
 * `idleCloseMs` of no activity (the default is 120 minutes). Runtime
 * instances are created lazily by the injected factory, so the core has no
 * DSH knowledge.
 */
export class AgentRuntimeHost {
  private readonly runtimes = new Map<string, AgentRuntime>();
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly active = new Set<string>();
  private readonly factory: (spec: AgentSessionSpec) => AgentRuntime;

  private idleCloseMs: number;

  constructor(
    factory: (spec: AgentSessionSpec) => AgentRuntime,
    idleCloseMs = 120 * 60 * 1000,
  ) {
    if (!Number.isFinite(idleCloseMs) || idleCloseMs < 0) {
      throw new Error("idleCloseMs must be a finite non-negative number");
    }
    this.factory = factory;
    this.idleCloseMs = idleCloseMs;
  }

  runtime(sessionId: string): AgentRuntime | undefined {
    return this.runtimes.get(sessionId);
  }

  async getTitle(sessionId: string): Promise<AgentRuntimeTitle | null> {
    const runtime = this.runtimes.get(sessionId);
    if (runtime === undefined) {
      throw new Error(`Runtime session "${sessionId}" is not active`);
    }
    if (runtime.getTitle === undefined) {
      throw new Error(`Runtime title capability is unavailable for session "${sessionId}"`);
    }
    return runtime.getTitle(sessionId);
  }

  async rename(sessionId: string, title: string): Promise<AgentRuntimeTitle> {
    const runtime = this.runtimes.get(sessionId);
    if (runtime === undefined) {
      throw new Error(`Runtime session "${sessionId}" is not active`);
    }
    if (runtime.rename === undefined) {
      throw new Error(`Runtime rename capability is unavailable for session "${sessionId}"`);
    }
    return runtime.rename(sessionId, title);
  }

  /** Return the live runtime for a session, creating it on first use. */
  ensure(spec: AgentSessionSpec): AgentRuntime {
    const existing = this.runtimes.get(spec.sessionId);
    if (existing !== undefined) return existing;
    const runtime = this.factory(spec);
    this.runtimes.set(spec.sessionId, runtime);
    return runtime;
  }

  /**
   * Probe a runtime without retaining it as a session runtime.  Adapters may
   * spawn a subprocess for this operation, so the temporary instance is
   * always closed before the promise resolves.
   */
  async discoverCapabilities(
    spec: AgentSessionSpec,
  ): Promise<AgentRuntimeCapabilities | null> {
    const runtime = this.factory(spec);
    try {
      return runtime.discoverCapabilities === undefined
        ? null
        : await runtime.discoverCapabilities(spec);
    } finally {
      await runtime.close();
    }
  }

  /** Change the idle retention policy and rearm only currently idle sessions. */
  updateIdleCloseMs(idleCloseMs: number): void {
    if (!Number.isFinite(idleCloseMs) || idleCloseMs < 0) {
      throw new Error("idleCloseMs must be a finite non-negative number");
    }
    this.idleCloseMs = idleCloseMs;
    for (const sessionId of this.runtimes.keys()) {
      if (this.active.has(sessionId)) continue;
      this.clearIdle(sessionId);
      this.armIdle(sessionId);
    }
  }

  idleCloseWindowMs(): number {
    return this.idleCloseMs;
  }

  /** Stop and forget a runtime so the next turn applies a changed spec. */
  async restart(sessionId: string): Promise<void> {
    await this.stop(sessionId);
    this.runtimes.delete(sessionId);
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
    this.armIdle(sessionId);
  }

  /** Stop the session's process now with cancel semantics. */
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

  private armIdle(sessionId: string): void {
    const runtime = this.runtimes.get(sessionId);
    if (runtime === undefined || this.active.has(sessionId) || this.idleCloseMs === 0) {
      return;
    }
    this.clearIdle(sessionId);
    const timer = setTimeout(() => {
      void this.stop(sessionId).catch(() => undefined);
    }, this.idleCloseMs);
    this.idleTimers.set(sessionId, timer);
  }
}
