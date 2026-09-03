import { DeepSeekHarness } from "@deepseek-ai/dsh-sdk-client";
import type { DeepSeekHarnessOptions } from "@deepseek-ai/dsh-sdk-client";
import type { HarnessNotification } from "@deepseek-ai/dsh-sdk-client";
import {
  type AgentRuntime,
  type AgentRuntimeEvent,
  type AgentSessionSpec,
} from "@loongboard/agent-runtime";

import { mapNotification } from "./notification-mapper.js";

export { mapNotification } from "./notification-mapper.js";
export type { DeepSeekHarnessOptions } from "@deepseek-ai/dsh-sdk-client";

/** Exact pin marker kept in sync with `dsh.lock.json`. */
export const DSH_RELEASE = "dsh-v0.1.2-alpha.5" as const;

/** Minimal async FIFO channel bridging SDK notifications to the generator. */
class NotificationChannel {
  private readonly items: HarnessNotification[] = [];
  private readonly waiters: Array<(item: HarnessNotification) => void> = [];
  private closed = false;

  push(notification: HarnessNotification): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter(notification);
      return;
    }
    this.items.push(notification);
  }

  close(): void {
    this.closed = true;
  }

  async take(): Promise<HarnessNotification | undefined> {
    const item = this.items.shift();
    if (item !== undefined) return item;
    if (this.closed) return undefined;
    return new Promise<HarnessNotification>((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * DSH-backed runtime: one pinned DeepSeekHarness subprocess per LoongBoard
 * session, each with its own DSH_HOME (plan 13.2/13.3). `stop` terminates the
 * subprocess; a later `run` starts a fresh subprocess against the same home
 * and reuses the runtime session id so model context survives (plan 13.3.10).
 * No DSH types cross the package boundary: callers only see
 * `AgentRuntimeEvent`.
 */
export class DSHRuntime implements AgentRuntime {
  private readonly harnesses = new Map<string, DeepSeekHarness | null>();
  private readonly runtimeSessionIds = new Map<string, string>();
  private readonly options: DeepSeekHarnessOptions;

  constructor(options: DeepSeekHarnessOptions = {}) {
    this.options = options;
  }

  async *run(
    spec: AgentSessionSpec,
    prompt: string,
  ): AsyncIterable<AgentRuntimeEvent> {
    yield { type: "status", status: "starting" };
    const harness = this.harnessFor(spec);
    yield { type: "status", status: "running" };
    const runtimeSessionId = spec.runtimeSessionId ?? this.runtimeSessionIds.get(spec.sessionId);
    const session = harness.session(runtimeSessionId);
    try {
      // True streaming (plan 13.3.6): the SDK delivers notifications while
      // `session.run` is still pending, so a channel lets the generator emit
      // normalized events as they arrive instead of replaying after idle.
      const channel = new NotificationChannel();
      const runPromise = (async (): Promise<
        | { ok: true; finalResponse: string }
        | { ok: false; errorMessage: string }
      > => {
        try {
          const result = await session.run(prompt, {
            onNotification: (notification: HarnessNotification) => {
              channel.push(notification);
            },
          });
          this.runtimeSessionIds.set(spec.sessionId, result.sessionId);
          return { ok: true, finalResponse: result.finalResponse };
        } catch (error) {
          return { ok: false, errorMessage: toError(error).message };
        } finally {
          channel.close();
        }
      })();

      // Drain live notifications until the run settles and the channel
      // closes; each notification maps to AgentRuntimeEvents in real time.
      while (true) {
        const notification = await channel.take();
        if (notification === undefined) break;
        for (const event of mapNotification(notification)) {
          yield event;
        }
      }
      const outcome = await runPromise;
      if (!outcome.ok) {
        yield { type: "error", message: outcome.errorMessage };
      } else if (outcome.finalResponse.length > 0) {
        // The final assistant text is guaranteed by the SDK and persisted
        // exactly once per turn.
        yield { type: "assistant.completed", markdown: outcome.finalResponse };
      }
    } catch (error) {
      yield {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      yield { type: "status", status: "idle" };
    }
  }

  /** Terminate the subprocess owning this session (plan 13.4). */
  async stop(sessionId: string): Promise<void> {
    const harness = this.harnesses.get(sessionId);
    if (harness === undefined) return;
    this.harnesses.set(sessionId, null);
    if (harness !== null) await harness.close();
  }

  /** Terminate every owned subprocess. */
  async close(): Promise<void> {
    const harnesses = [...this.harnesses.entries()];
    this.harnesses.clear();
    await Promise.all(
      harnesses.map(async ([sessionId, harness]) => {
        if (harness !== null) await harness.close();
        void sessionId;
      }),
    );
  }

  runtimeSessionId(sessionId: string): string | null {
    return this.runtimeSessionIds.get(sessionId) ?? null;
  }

  private harnessFor(spec: AgentSessionSpec): DeepSeekHarness {
    const existing = this.harnesses.get(spec.sessionId);
    if (existing !== undefined && existing !== null) return existing;
    const harness = new DeepSeekHarness({
      ...this.options,
      cwd: spec.workspacePath,
      dshHome: spec.dshHomePath,
      profile: "sdk",
      provider: spec.provider,
      model: spec.model,
      ...(spec.reasoningEffort
        ? { reasoningEffort: spec.reasoningEffort as DeepSeekHarnessOptions["reasoningEffort"] }
        : {}),
      ...(spec.maxTokens !== undefined ? { maxTokens: spec.maxTokens } : {}),
    });
    this.harnesses.set(spec.sessionId, harness);
    return harness;
  }
}
