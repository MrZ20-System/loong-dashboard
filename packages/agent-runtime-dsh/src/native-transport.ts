import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import WebSocket from "ws";
import { z } from "zod";
import type { AgentSessionSpec } from "@loongboard/agent-runtime";

const require = createRequire(import.meta.url);
const responseSchema = z.object({
  type: z.literal("server-response"),
  rpcId: z.string(),
  result: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), value: z.unknown().optional() }),
    z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) }),
  ]),
});
const streamSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("item"), streamId: z.string(), value: z.unknown() }),
  z.object({ type: z.literal("end"), streamId: z.string() }),
  z.object({ type: z.literal("error"), streamId: z.string(), error: z.object({ message: z.string() }) }),
]);

/** The upstream Host API transport stays entirely inside this adapter. */
export interface NativeDshTransport {
  request(endpoint: string, args: Record<string, unknown>): Promise<unknown>;
  follow(endpoint: string, args: Record<string, unknown>, signal?: AbortSignal): AsyncIterable<unknown>;
  close(): Promise<void>;
}

export interface NativeDshTransportOptions {
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
}

/** Small FIFO; closing wakes a pending reader and rejects future reads on failure. */
export class NativeChannel<T> {
  private readonly items: T[] = [];
  private waiter: (() => void) | undefined;
  private closed = false;
  private failure: Error | undefined;
  push(item: T): void {
    if (this.closed) return;
    this.items.push(item);
    this.waiter?.();
    this.waiter = undefined;
  }
  close(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.failure = error;
    this.waiter?.();
    this.waiter = undefined;
  }
  async take(): Promise<T | undefined> {
    while (this.items.length === 0 && !this.closed) {
      await new Promise<void>((resolve) => { this.waiter = resolve; });
    }
    const item = this.items.shift();
    if (item !== undefined) return item;
    if (this.failure !== undefined) throw this.failure;
    return undefined;
  }
}

/**
 * Supervise the supported `dsh --profile web` service without embedding its UI.
 * Launch-token exchange and the private cookie never cross the server boundary.
 */
export class NativeDshProcess implements NativeDshTransport {
  private process: ChildProcess | undefined;
  private ready: Promise<{ origin: string; cookie: string }> | undefined;
  private readonly sockets = new Set<WebSocket>();
  private readonly lifetime = new AbortController();
  private closing: Promise<void> | undefined;

  constructor(private readonly spec: AgentSessionSpec, private readonly options: NativeDshTransportOptions = {}) {}

  async request(endpoint: string, args: Record<string, unknown>): Promise<unknown> {
    const { origin, cookie } = await this.start();
    const rpcId = randomUUID();
    const response = await fetch(`${origin}/api/${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ type: "client-request", rpcId, method: endpoint, payload: { args } }),
      signal: this.lifetime.signal,
    });
    if (!response.ok) throw new Error(`DSH ${endpoint}: HTTP ${response.status}`);
    const envelope = responseSchema.parse(await response.json());
    if (envelope.rpcId !== rpcId) throw new Error(`DSH ${endpoint}: response identity mismatch`);
    if (!envelope.result.ok) throw new Error(`DSH ${endpoint}: ${envelope.result.error.message}`);
    return envelope.result.value;
  }

  async *follow(endpoint: string, args: Record<string, unknown>, signal?: AbortSignal): AsyncIterable<unknown> {
    if (signal?.aborted) return;
    const { origin, cookie } = await this.start();
    if (signal?.aborted) return;
    const socket = new WebSocket(`${origin.replace("http:", "ws:")}/api/remote.mux`, { headers: { cookie } });
    const streamId = randomUUID();
    const channel = new NativeChannel<unknown>();
    const abort = () => { channel.close(); socket.terminate(); };
    signal?.addEventListener("abort", abort, { once: true });
    this.sockets.add(socket);
    socket.on("open", () => socket.send(JSON.stringify({ type: "open", streamId, endpoint, payload: { args } })));
    socket.on("message", (message) => {
      try {
        const frame = streamSchema.parse(JSON.parse(message.toString()));
        if (frame.streamId !== streamId) throw new Error("DSH stream identity mismatch");
        if (frame.type === "item") channel.push(frame.value);
        else if (frame.type === "error") channel.close(new Error(frame.error.message));
        else channel.close();
      } catch (error) {
        channel.close(asError(error));
        socket.close();
      }
    });
    socket.on("error", (error) => channel.close(error));
    socket.on("close", () => channel.close(new Error("DSH event stream closed")));
    try {
      while (true) {
        const value = await channel.take();
        if (value === undefined) return;
        yield value;
      }
    } finally {
      signal?.removeEventListener("abort", abort);
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "cancel", streamId }));
      socket.close();
      this.sockets.delete(socket);
    }
  }

  close(): Promise<void> {
    this.closing ??= this.dispose();
    return this.closing;
  }

  private start(): Promise<{ origin: string; cookie: string }> {
    if (this.lifetime.signal.aborted) return Promise.reject(new Error("DSH process is closed"));
    this.ready ??= this.launch();
    return this.ready;
  }

  private async launch(): Promise<{ origin: string; cookie: string }> {
    mkdirSync(this.spec.dshHomePath, { recursive: true, mode: 0o700 });
    const binary = join(dirname(require.resolve("@deepseek-ai/dsh/package.json")), "lib/bin.js");
    const environment: NodeJS.ProcessEnv = { ...(this.options.env ?? process.env), DSH_HOME: this.spec.dshHomePath };
    // GitHub HTTP and CLI credentials belong to the GitHub adapter.
    delete environment.GH_TOKEN;
    delete environment.GITHUB_TOKEN;
    const child = spawn(process.execPath, [binary, "--profile", "web", "--no-open", "--port", "0"], {
      cwd: this.spec.workspacePath,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.process = child;
    const timeout = AbortSignal.timeout(this.options.startupTimeoutMs ?? 30_000);
    const signal = AbortSignal.any([timeout, this.lifetime.signal]);
    const launchUrl = await new Promise<string>((resolve, reject) => {
      let output = "";
      const abort = () => finish(new Error("DSH startup was cancelled or timed out"));
      const onError = (error: Error) => finish(error);
      const onExit = (code: number | null) => finish(new Error(`DSH exited before readiness (code ${code})`));
      const finish = (error?: Error, url?: string) => {
        signal.removeEventListener("abort", abort);
        child.removeListener("error", onError);
        child.removeListener("exit", onExit);
        if (error !== undefined) reject(error);
        else resolve(url as string);
      };
      signal.addEventListener("abort", abort, { once: true });
      child.once("error", onError);
      child.once("exit", onExit);
      if (signal.aborted) abort();
      child.stderr?.resume();
      child.stdout?.on("data", (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-16_384);
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/);
        if (match?.[0] !== undefined) finish(undefined, match[0]);
      });
    });
    const auth = await fetch(launchUrl, { redirect: "manual", signal });
    if (auth.status !== 302 && auth.status !== 303) throw new Error(`DSH authentication failed: HTTP ${auth.status}`);
    const cookie = auth.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    if (!cookie) throw new Error("DSH authentication returned no session cookie");
    return { origin: new URL(launchUrl).origin, cookie };
  }

  private async dispose(): Promise<void> {
    this.lifetime.abort();
    for (const socket of this.sockets) socket.terminate();
    this.sockets.clear();
    const child = this.process;
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      child.kill("SIGTERM");
    });
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
