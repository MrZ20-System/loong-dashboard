import { DeepSeekHarness } from "@deepseek-ai/dsh-sdk-client";
import type { DeepSeekHarnessOptions } from "@deepseek-ai/dsh-sdk-client";
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
      const result = await session.run(prompt, {
        onNotification: () => undefined,
      });
      this.runtimeSessionIds.set(spec.sessionId, result.sessionId);
      // Surface the normalized delta/tool events so the SSE and DB layers see
      // the same shapes the live path emits.
      for (const notification of result.notifications) {
        for (const event of mapNotification(notification)) {
          yield event;
        }
      }
      if (result.finalResponse.length > 0) {
        yield { type: "assistant.completed", markdown: result.finalResponse };
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
