import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { HarnessNotification } from "@deepseek-ai/dsh-sdk-client";
import type { AgentRuntimeCapabilities, AgentRuntime, AgentRuntimeEvent, AgentRuntimeTitle, AgentSessionSpec } from "@loongboard/agent-runtime";
import { DshNotificationMapper } from "./notification-mapper.js";
import { NativeChannel, NativeDshProcess, type NativeDshTransport, type NativeDshTransportOptions } from "./native-transport.js";
import { configureNativeCredential } from "./native-credentials.js";

export { DshNotificationMapper } from "./notification-mapper.js";
export type { NativeDshTransport } from "./native-transport.js";
export const DSH_RELEASE = "dsh-v0.1.2-alpha.5" as const;

export interface DSHRuntimeOptions extends NativeDshTransportOptions {
  transportFactory?: (spec: AgentSessionSpec) => NativeDshTransport;
  /** Private server credential source; resolved through DSH's own provider settings. */
  credentials?: () => Promise<Record<string, string>>;
}
const catalogSchema = z.object({
  groups: z.array(z.object({ id: z.string(), name: z.string(), models: z.array(z.object({
    id: z.string(), name: z.string(), reasoning: z.object({ efforts: z.array(z.object({ id: z.string() })) }).optional(),
  })) })),
  failures: z.array(z.object({ message: z.string() })).optional(),
});
const commandSchema = z.array(z.object({ name: z.string(), description: z.string().optional() }));
const journalSchema = z.object({ type: z.literal("event"), event: z.object({
  type: z.string(), seq: z.number(), time: z.number(), data: z.unknown(),
}) });
const sessionListSchema = z.object({
  items: z.array(z.object({
    sessionId: z.string(),
    projections: z.object({
      values: z.object({ title: z.string().nullable().optional() }).passthrough(),
    }).optional(),
  }).passthrough()),
}).passthrough();
type Frame = { source: "host" | "journal"; value: unknown };
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const title = value.replace(/\s+/gu, " ").trim();
  const bounded = Array.from(title).slice(0, 80).join("");
  return bounded.length > 0 ? bounded : null;
}

function titleFromFrame(value: unknown): AgentRuntimeTitle | null {
  const frame = record(value);
  if (frame.type === "snapshot") {
    const records = Array.isArray(frame.records) ? frame.records : [];
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const title = titleFromFrame(records[index]);
      if (title !== null) return title;
    }
    const projection = record(record(frame.projections).values);
    const title = normalizeTitle(projection.title);
    return title === null ? null : { title };
  }
  if (frame.type !== "event") return null;
  const event = record(frame.event);
  if (event.type !== "session/title") return null;
  const data = record(event.data);
  const title = normalizeTitle(data.title);
  if (title === null) return null;
  const source = record(data.source).kind;
  return source === "fallback" || source === "provider" || source === "user"
    ? { title, source }
    : { title };
}

/** One supported native DSH Host per isolated LoongBoard conversation. */
export class DSHRuntime implements AgentRuntime {
  private readonly transports = new Map<string, NativeDshTransport>();
  private readonly pendingInteractions = new Map<string, { sessionId: string; clientId: string; transport: NativeDshTransport }>();
  private readonly runtimeSessionIds = new Map<string, string>();
  private readonly titles = new Map<string, AgentRuntimeTitle>();
  constructor(private readonly options: DSHRuntimeOptions = {}) {}

  private async transportFor(spec: AgentSessionSpec): Promise<NativeDshTransport> {
    let transport = this.transports.get(spec.sessionId);
    if (transport === undefined) {
      transport = this.options.transportFactory?.(spec) ?? new NativeDshProcess(spec, this.options);
      this.transports.set(spec.sessionId, transport);
    }
    for (const [provider, secret] of Object.entries(await this.options.credentials?.() ?? {})) {
      await configureNativeCredential(transport, provider, secret);
    }
    return transport;
  }

  private async ensureSession(transport: NativeDshTransport, spec: AgentSessionSpec): Promise<string> {
    const existing = spec.runtimeSessionId ?? this.runtimeSessionIds.get(spec.sessionId);
    const result = z.object({ sessionId: z.string() }).parse(await transport.request("session/create", {
      request: { cwd: spec.workspacePath, ...(existing ? { sessionId: existing } : {}) },
    }));
    this.runtimeSessionIds.set(spec.sessionId, result.sessionId);
    return result.sessionId;
  }

  async *run(spec: AgentSessionSpec, prompt: string): AsyncGenerator<AgentRuntimeEvent> {
    yield { type: "status", status: "starting" };
    const abort = new AbortController();
    const pumps: Promise<void>[] = [];
    try {
      const transport = await this.transportFor(spec);
      const sessionId = await this.ensureSession(transport, spec);
      await transport.request("session/selectModel", { request: {
        sessionId, provider: spec.provider, model: spec.model,
        ...(spec.reasoningEffort ? { reasoningEffort: spec.reasoningEffort } : {}),
      } });
      yield { type: "status", status: "running" };
      if (prompt.trimStart().startsWith("/")) {
        const command = await transport.request("commands/execute", { agentId: sessionId, line: prompt.trim(), images: [] });
        if (command !== undefined && command !== null) {
          const parsed = z.object({ commandId: z.string(), result: z.object({ kind: z.enum(["success", "error"]), text: z.string().optional() }) }).parse(command);
          yield { type: "agent.activity", kind: "command", phase: parsed.result.kind === "success" ? "completed" : "failed", id: parsed.commandId, title: prompt.trim().split(/\s/)[0], ...(parsed.result.text ? { summary: parsed.result.text } : {}) };
          if (parsed.result.kind === "error") yield { type: "error", message: parsed.result.text ?? "DSH command failed" };
          else if (parsed.result.text) yield { type: "assistant.completed", markdown: parsed.result.text };
          return;
        }
      }
      const channel = new NativeChannel<Frame>();
      const startPump = (source: Frame["source"], endpoint: string, args: Record<string, unknown>) => {
        let ready!: () => void;
        let fail!: (error: unknown) => void;
        const readiness = new Promise<void>((resolve, reject) => { ready = resolve; fail = reject; });
        pumps.push((async () => {
          try {
            let first = true;
            for await (const value of transport.follow(endpoint, args, abort.signal)) {
              if (first) { first = false; ready(); }
              channel.push({ source, value });
            }
            if (!abort.signal.aborted) throw new Error(`DSH ${source} stream ended before completion`);
          } catch (error) {
            fail(error);
            if (!abort.signal.aborted) channel.close(error instanceof Error ? error : new Error(String(error)));
          }
        })());
        return readiness;
      };
      // Subscribe and receive initial snapshots before admission so fast turns cannot be lost.
      await Promise.all([
        startPump("host", "$events", {}),
        startPump("journal", "session/follow", { request: { address: { kind: "session", sessionId }, maxMessages: 1 } }),
      ]);
      await transport.request("session/prompt", { request: { requestId: randomUUID(), sessionId, mode: "queue", content: [{ type: "text", text: prompt }] } });
      const mapper = new DshNotificationMapper();
      let clientId: string | undefined;
      let idle = false;
      let ended = false;
      let finalText = "";
      let failure: string | undefined;
      while (true) {
        const frame = await channel.take();
        if (frame === undefined) throw new Error("DSH event channel closed before completion");
        if (frame.source === "host") {
          const host = record(frame.value);
          const args = Array.isArray(host.args) ? host.args : [];
          if (host.type === "ready" && typeof host.clientId === "string") clientId = host.clientId;
          if (host.type === "cancel" && typeof host.eventId === "string") {
            this.pendingInteractions.delete(host.eventId);
            yield { type: "interaction.resolved", requestId: host.eventId };
          }
          if (host.type === "waterfall" && typeof host.eventId === "string" && clientId) {
            const request = record(host.request);
            if (host.event === "approval/request" && typeof host.agentId === "string") {
              this.pendingInteractions.set(host.eventId, { sessionId: spec.sessionId, clientId, transport });
              yield { type: "interaction.requested", requestId: host.eventId, kind: "approval",
                title: typeof request.toolName === "string" ? `Allow ${request.toolName}?` : "Runtime approval",
                ...(typeof request.reason === "string" ? { description: request.reason } : {}),
                options: [{ id: "rejected", label: "Reject" }, { id: "allowed-once", label: "Allow once" }],
              };
            } else {
              // Preserve the Host's native fallback for unhandled future interactions.
              await transport.request("$events/result", { clientId, eventId: host.eventId, outcome: { kind: "next" } });
            }
          }
          if (host.type === "emit" && args[0] === sessionId) {
            if (host.event === "api-session/status") idle = args[1] === false;
            if (host.event === "api-session/error") { failure = typeof args[1] === "string" ? args[1] : "DSH session failed"; break; }
          }
        } else {
          const title = titleFromFrame(frame.value);
          if (title !== null) this.titles.set(spec.sessionId, title);
          const parsed = journalSchema.safeParse(frame.value);
          if (parsed.success) {
            const event = parsed.data.event;
            const data = record(event.data);
            if (event.type === "turn/start") { ended = false; finalText = ""; }
            if (event.type === "assistant/message") {
              const content = record(data.message).content;
              if (Array.isArray(content)) finalText = content.map(record).filter((part) => part.type === "text").map((part) => typeof part.text === "string" ? part.text : "").join("");
            }
            if (event.type === "turn/end") {
              ended = true;
              const reason = record(data.reason);
              if (reason.kind === "error" || reason.kind === "blocked") failure = String(record(reason.error).message ?? `DSH turn ${reason.kind}`);
            }
            for (const normalized of mapper.map({ method: "session.event", params: { sessionId, event } } as HarnessNotification)) yield normalized;
          }
        }
        // Host idle and the durable final event arrive on independent streams.
        if (idle && ended) break;
      }
      if (finalText) yield { type: "assistant.completed", markdown: finalText };
      if (failure) yield { type: "error", message: failure };
    } catch (error) {
      yield { type: "error", message: error instanceof Error ? error.message : String(error) };
    } finally {
      for (const [id, pending] of this.pendingInteractions) {
        if (pending.sessionId === spec.sessionId) this.pendingInteractions.delete(id);
      }
      abort.abort();
      await Promise.all(pumps);
      yield { type: "status", status: "idle" };
    }
  }

  async discoverCapabilities(spec: AgentSessionSpec): Promise<AgentRuntimeCapabilities> {
    try {
      const transport = await this.transportFor(spec);
      const sessionId = await this.ensureSession(transport, spec);
      const [rawCatalog, rawCommands, rawProviders] = await Promise.all([
        transport.request("session/modelCatalog", {}), transport.request("commands/list", { agentId: sessionId }),
        transport.request("llm/listConfigurableProviders", {}),
      ]);
      const catalog = catalogSchema.parse(rawCatalog);
      const providers = z.array(z.object({ provider: z.string(), displayName: z.string().optional() })).parse(rawProviders).map((provider) => ({ id: provider.provider, ...(provider.displayName ? { label: provider.displayName } : {}) }));
      const models = catalog.groups.flatMap((group) => group.models.map((model) => ({ id: model.id, label: model.name, provider: group.id, reasoningEfforts: model.reasoning?.efforts.map((effort) => effort.id) ?? [] })));
      return { runtimeKind: "dsh", version: DSH_RELEASE, profile: "web", connected: true, models, providers,
        reasoning: [...new Set(models.flatMap((model) => model.reasoningEfforts))],
        commands: commandSchema.parse(rawCommands).map((command) => ({ id: command.name, ...(command.description ? { description: command.description } : {}) })),
        features: ["session.prompt", "session.follow", "session.selectModel", "commands.execute"], discovery: "runtime", discoveredAt: new Date().toISOString(),
        ...(catalog.failures?.length ? { error: catalog.failures.map((failure) => failure.message).join("; ") } : {}),
      };
    } catch (error) {
      return { runtimeKind: "dsh", version: DSH_RELEASE, profile: "web", connected: false, models: [], reasoning: [], commands: [], features: [], discovery: "unavailable", discoveredAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) };
    }
  }
  async respond(sessionId: string, requestId: string, value: unknown): Promise<void> {
    const pending = this.pendingInteractions.get(requestId);
    if (!pending || pending.sessionId !== sessionId) throw new Error("Runtime interaction is no longer active");
    if (value !== "allowed-once" && value !== "rejected") throw new Error("Invalid runtime approval response");
    await pending.transport.request("$events/result", { clientId: pending.clientId, eventId: requestId, outcome: { kind: "result", value } });
    this.pendingInteractions.delete(requestId);
  }
  runtimeSessionId(sessionId: string): string | null { return this.runtimeSessionIds.get(sessionId) ?? null; }

  async getTitle(sessionId: string): Promise<AgentRuntimeTitle | null> {
    const runtimeSessionId = this.requireRuntimeSessionId(sessionId, "read title");
    const transport = this.requireTransport(sessionId, "read title");
    const cached = this.titles.get(sessionId);
    const result = sessionListSchema.parse(await transport.request("session/list", { _request: {} }));
    const row = result.items.find((item) => item.sessionId === runtimeSessionId);
    if (row === undefined) {
      throw new Error(`DSH cannot read title for session "${sessionId}": runtime session "${runtimeSessionId}" was not found`);
    }
    const title = normalizeTitle(row.projections?.values.title);
    if (title === null) return this.titles.get(sessionId) ?? null;
    const next = { title, ...(cached?.title === title && cached.source ? { source: cached.source } : {}) };
    this.titles.set(sessionId, next);
    return next;
  }

  async rename(sessionId: string, title: string): Promise<AgentRuntimeTitle> {
    const normalized = normalizeTitle(title);
    if (normalized === null) throw new Error(`DSH cannot rename session "${sessionId}": title must not be empty`);
    const runtimeSessionId = this.requireRuntimeSessionId(sessionId, "rename session");
    const transport = this.requireTransport(sessionId, "rename session");
    const result = z.object({ title: z.string(), seq: z.number() }).parse(
      await transport.request("session/rename", { request: { sessionId: runtimeSessionId, title: normalized } }),
    );
    const accepted = normalizeTitle(result.title);
    if (accepted === null) throw new Error(`DSH rename for session "${sessionId}" returned an empty title`);
    const value: AgentRuntimeTitle = { title: accepted, source: "user" };
    this.titles.set(sessionId, value);
    return value;
  }

  private requireRuntimeSessionId(sessionId: string, operation: string): string {
    const runtimeSessionId = this.runtimeSessionIds.get(sessionId);
    if (runtimeSessionId === undefined) {
      throw new Error(`DSH cannot ${operation} for session "${sessionId}": no runtime session id is available; run or resume the session first`);
    }
    return runtimeSessionId;
  }

  private requireTransport(sessionId: string, operation: string): NativeDshTransport {
    const transport = this.transports.get(sessionId);
    if (transport === undefined) {
      throw new Error(`DSH cannot ${operation} for session "${sessionId}": runtime is not active`);
    }
    return transport;
  }

  async stop(sessionId: string): Promise<void> {
    const transport = this.transports.get(sessionId);
    this.transports.delete(sessionId);
    // The controller supplies a persisted id for idle resume. A cancelled
    // turn deliberately supplies none and must not inherit this local cache.
    this.runtimeSessionIds.delete(sessionId);
    this.titles.delete(sessionId);
    if (transport) await transport.close();
  }
  async close(): Promise<void> {
    const transports = [...this.transports.values()];
    this.transports.clear();
    this.runtimeSessionIds.clear();
    this.titles.clear();
    await Promise.all(transports.map((transport) => transport.close()));
  }
}
