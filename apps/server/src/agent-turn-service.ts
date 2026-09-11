import { mkdirSync } from "node:fs";

import {
  appendAgentMessage,
  updateAgentMessage,
  type DatabaseClient,
} from "@loongboard/database";
import {
  agentRuntimeEventSchema,
  type AgentMessageAccepted,
  type AgentRuntimeEvent as ContractEvent,
  type AgentSessionSummary,
} from "@loongboard/contracts";
import type { AgentRuntime, AgentSessionSpec } from "@loongboard/agent-runtime";

import { InvalidRequestError } from "./route-helpers.js";
import { AgentEventHub } from "./agent-event-hub.js";
import { AgentSessionService } from "./agent-session-service.js";
import type { WorkspaceRunCoordinator } from "./workspace-run-coordinator.js";

export class AgentTurnBusyError extends Error {
  readonly code = "AGENT_TURN_BUSY" as const;

  constructor(sessionId: string) {
    super(`Agent session ${sessionId} already has a running turn`);
    this.name = "AgentTurnBusyError";
  }
}

export class AgentInteractionUnavailableError extends Error {
  readonly code = "AGENT_INTERACTION_UNAVAILABLE" as const;

  constructor(sessionId: string, reason = "the session has no active interaction") {
    super(`Agent session ${sessionId} cannot resolve an interaction: ${reason}`);
    this.name = "AgentInteractionUnavailableError";
  }
}

/** The workspace is claimed by another agent turn (Chat or scheduler). */
export class WorkspaceRunBusyError extends Error {
  readonly code = "WORKSPACE_BUSY" as const;

  constructor(workspacePath: string) {
    super(`Another agent turn is already using the workspace: ${workspacePath}`);
    this.name = "WorkspaceRunBusyError";
  }
}

export interface AgentTurnServiceOptions {
  database: DatabaseClient;
  workspaceRuns: WorkspaceRunCoordinator;
  sessions: AgentSessionService;
  events: AgentEventHub;
}

/**
 * Owns workspace admission, prompt execution, normalized runtime persistence,
 * cancellation, and interaction responses. It consumes only the product
 * runtime contract; vendor-specific SessionEvent values never enter here.
 */
export class AgentTurnService {
  private readonly database: DatabaseClient;
  private readonly workspaceRuns: WorkspaceRunCoordinator;
  private readonly sessions: AgentSessionService;
  private readonly events: AgentEventHub;
  private readonly runningTurns = new Map<string, Promise<void>>();
  private readonly cancelled = new Set<string>();

  constructor(options: AgentTurnServiceOptions) {
    this.database = options.database;
    this.workspaceRuns = options.workspaceRuns;
    this.sessions = options.sessions;
    this.events = options.events;
  }

  /** Accept a user message and start its turn in the background. */
  async acceptMessage(
    sessionId: string,
    content: string,
  ): Promise<AgentMessageAccepted> {
    this.ensureNotRunning(sessionId);
    const session = this.sessions.require(sessionId);
    await this.sessions.requireRevisionMatch(session);
    const release = this.acquireWorkspace(session);
    try {
      const userMessage = appendAgentMessage(this.database, {
        sessionId,
        role: "user",
        contentMarkdown: content,
      });
      const turn = this.runTurn(session, content);
      this.runningTurns.set(sessionId, turn);
      void turn.then(
        () => this.finishBackgroundTurn(sessionId, release),
        () => this.finishBackgroundTurn(sessionId, release),
      );
      return { messageId: userMessage.id, status: "accepted" };
    } catch (error) {
      release();
      throw error;
    }
  }

  /**
   * Run one already-persisted prompt to completion. Scheduled runs already
   * own their workspace, so they pass workspaceOwned=true to avoid a second
   * admission attempt on the same path.
   */
  async runSessionTurn(
    sessionId: string,
    prompt: string,
    options: { workspaceOwned?: boolean } = {},
  ): Promise<AgentSessionSummary> {
    this.ensureNotRunning(sessionId);
    const session = this.sessions.require(sessionId);
    await this.sessions.requireRevisionMatch(session);
    const release = options.workspaceOwned === true ? null : this.acquireWorkspace(session);
    try {
      const turn = this.runTurn(session, prompt);
      this.runningTurns.set(sessionId, turn);
      try {
        await turn;
      } finally {
        this.finishTurn(sessionId);
      }
    } finally {
      release?.();
    }
    return this.sessions.require(sessionId);
  }

  /** Cancel one session by stopping its runtime process. */
  async cancel(sessionId: string) {
    this.sessions.require(sessionId);
    const running = this.runningTurns.has(sessionId);
    if (running) this.cancelled.add(sessionId);
    await this.sessions.restartRuntime(sessionId);
    this.sessions.updateRuntimeState(sessionId, {
      status: "interrupted",
      ...(running ? { dshSessionId: null } : {}),
    });
    this.events.broadcast(sessionId, { type: "status", status: "stopped" });
    return this.sessions.view(sessionId);
  }

  /** Resolve a runtime-owned interaction without bypassing the runtime. */
  async respond(sessionId: string, requestId: string, value: string): Promise<void> {
    if (requestId.trim().length === 0) {
      throw new InvalidRequestError("Interaction requestId must not be empty");
    }
    if (value.trim().length === 0) {
      throw new InvalidRequestError("Interaction value must not be empty");
    }
    this.sessions.require(sessionId);
    if (!this.runningTurns.has(sessionId) || !this.sessions.isRuntimeRunning(sessionId)) {
      throw new AgentInteractionUnavailableError(sessionId);
    }
    const runtime = this.sessions.runtime(sessionId);
    if (runtime?.respond === undefined) {
      throw new AgentInteractionUnavailableError(
        sessionId,
        "the connected runtime does not support responses",
      );
    }
    this.events.markInteractionResolution(sessionId, requestId);
    try {
      await this.sessions.respondRuntime(runtime, sessionId, requestId, value);
    } catch (error) {
      this.events.forgetInteractionResolution(sessionId, requestId);
      throw error;
    }
    const resolved: ContractEvent = {
      type: "interaction.resolved",
      requestId,
    };
    this.persistRuntimeEvent(sessionId, resolved, new Map());
    this.events.broadcast(sessionId, resolved);
  }

  isRunning(sessionId: string): boolean {
    return this.runningTurns.has(sessionId);
  }

  /** Close the runtime after allowing active turn generators to unwind. */
  async close(): Promise<void> {
    const pendingTurns = [...this.runningTurns.values()];
    await this.sessions.closeRuntime();
    await Promise.allSettled(pendingTurns);
    this.cancelled.clear();
    this.runningTurns.clear();
  }

  private ensureNotRunning(sessionId: string): void {
    if (this.runningTurns.has(sessionId)) throw new AgentTurnBusyError(sessionId);
  }

  private acquireWorkspace(session: AgentSessionSummary): () => void {
    const release = this.workspaceRuns.acquire(session.workspacePath);
    if (release === null) throw new WorkspaceRunBusyError(session.workspacePath);
    return release;
  }

  private finishBackgroundTurn(sessionId: string, release: () => void): void {
    this.finishTurn(sessionId);
    release();
  }

  private finishTurn(sessionId: string): void {
    this.runningTurns.delete(sessionId);
    this.cancelled.delete(sessionId);
  }

  private async runTurn(session: AgentSessionSummary, prompt: string): Promise<void> {
    // A user- or startup-interrupted session may hold an opaque id for a turn
    // whose durable log was cut mid-flight. Clear it before retrying. Native
    // errors already ended their turn and retain the id for recovery.
    const resumeRuntimeSessionId =
      session.status === "interrupted" ? undefined : (session.dshSessionId ?? undefined);
    if (session.status === "interrupted" && session.dshSessionId !== null) {
      this.sessions.updateRuntimeState(session.id, { dshSessionId: null });
    }
    const spec: AgentSessionSpec = {
      sessionId: session.id,
      workspacePath: session.workspacePath,
      provider: session.provider,
      model: session.model,
      reasoningEffort: session.reasoningEffort,
      dshHomePath: session.dshHomePath,
      runtimeSessionId: resumeRuntimeSessionId,
    };
    mkdirSync(session.dshHomePath, { recursive: true });
    this.sessions.updateRuntimeState(session.id, { status: "running" });
    this.sessions.beginRuntimeRun(session.id);
    let receivedCompletion = false;
    let terminalIdle = false;
    let runtimeFailed = false;
    let persistedRuntimeSessionId = resumeRuntimeSessionId ?? null;
    const toolMessageIds = new Map<string, string>();
    try {
      const runtime = this.sessions.ensureRuntime(spec);
      this.events.broadcast(session.id, { type: "status", status: "starting" });
      for await (const event of runtime.run(spec, prompt)) {
        if (this.cancelled.has(session.id)) break;
        const normalized = agentRuntimeEventSchema.parse(event);
        const runtimeSessionId = this.sessions.runtimeSessionId(runtime, session.id);
        if (
          runtimeSessionId !== null &&
          runtimeSessionId !== persistedRuntimeSessionId
        ) {
          this.sessions.updateRuntimeState(session.id, {
            dshSessionId: runtimeSessionId,
          });
          persistedRuntimeSessionId = runtimeSessionId;
        }
        if (
          normalized.type === "interaction.resolved" &&
          this.events.consumeInteractionResolution(session.id, normalized.requestId)
        ) {
          // respond() already persisted and broadcast this acknowledgement.
          continue;
        }
        this.persistRuntimeEvent(session.id, normalized, toolMessageIds);
        if (normalized.type === "assistant.completed") receivedCompletion = true;
        if (normalized.type === "status" && normalized.status === "idle") terminalIdle = true;
        if (normalized.type === "error") runtimeFailed = true;
        this.events.broadcast(session.id, normalized);
      }
    } catch (error) {
      runtimeFailed = true;
      const message = error instanceof Error ? error.message : String(error);
      this.events.broadcast(session.id, { type: "error", message });
      appendAgentMessage(this.database, {
        sessionId: session.id,
        role: "system-status",
        contentMarkdown: message,
      });
    } finally {
      const interrupted = this.cancelled.has(session.id);
      const completed = (terminalIdle || receivedCompletion) && !runtimeFailed;
      this.sessions.endRuntimeRun(session.id);
      const nextStatus = interrupted ? "interrupted" : completed ? "idle" : "error";
      this.sessions.updateRuntimeState(session.id, {
        status: nextStatus,
        ...(nextStatus === "interrupted" ? { dshSessionId: null } : {}),
      });
      this.events.broadcast(session.id, { type: "status", status: "idle" });
      this.events.clearInteractionResolutions(session.id);
      if (!interrupted && completed) {
        // Native title discovery is secondary metadata and never extends the
        // turn's completion boundary.
        void this.refreshTitle(session.id);
      }
    }
  }

  private async refreshTitle(sessionId: string): Promise<void> {
    try {
      const updated = await this.sessions.discoverNativeTitle(sessionId);
      if (updated) this.events.broadcast(sessionId, { type: "status", status: "idle" });
    } catch {
      // Title discovery is best-effort metadata and cannot affect the turn.
    }
  }

  /** Persist only LoongBoard-normalized rows. */
  private persistRuntimeEvent(
    sessionId: string,
    event: ContractEvent,
    toolMessageIds: Map<string, string>,
  ): void {
    switch (event.type) {
      case "assistant.completed":
        if (event.markdown.length > 0) {
          appendAgentMessage(this.database, {
            sessionId,
            role: "assistant",
            contentMarkdown: event.markdown,
          });
        }
        break;
      case "tool.started": {
        const message = appendAgentMessage(this.database, {
          sessionId,
          role: "tool",
          contentMarkdown: `**${event.name}**`,
          metadata: { callId: event.callId, name: event.name, status: "running" },
        });
        toolMessageIds.set(event.callId, message.id);
        break;
      }
      case "tool.completed": {
        const existingId = toolMessageIds.get(event.callId);
        if (existingId !== undefined) {
          updateAgentMessage(this.database, existingId, {
            contentMarkdown: event.isError
              ? `**${event.name}** failed${event.summary !== undefined ? ` — ${event.summary}` : ""}`
              : event.summary !== undefined
                ? `**${event.name}**: ${event.summary}`
                : `**${event.name}**`,
            metadata: {
              callId: event.callId,
              name: event.name,
              status: "done",
              isError: event.isError,
            },
          });
        }
        break;
      }
      case "interaction.requested":
        appendAgentMessage(this.database, {
          sessionId,
          role: "system-status",
          contentMarkdown: `Approval requested: ${event.title}`,
          metadata: {
            type: event.type,
            requestId: event.requestId,
            kind: event.kind,
            ...(event.description !== undefined ? { description: event.description } : {}),
            options: event.options,
          },
        });
        break;
      case "interaction.resolved":
        appendAgentMessage(this.database, {
          sessionId,
          role: "system-status",
          contentMarkdown: `Approval resolved: ${event.requestId}`,
          metadata: { type: event.type, requestId: event.requestId },
        });
        break;
      case "error":
        appendAgentMessage(this.database, {
          sessionId,
          role: "system-status",
          contentMarkdown: `Run error: ${event.message}`,
        });
        break;
      default:
        break;
    }
  }
}
