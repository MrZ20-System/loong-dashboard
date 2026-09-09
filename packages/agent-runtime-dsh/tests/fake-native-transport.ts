import type { NativeDshTransport } from "../src/native-transport.js";

type Request = {
  endpoint: string;
  args: Record<string, unknown>;
};

type Waiter = (value: unknown | typeof END) => void;
const END = Symbol("end");

class AsyncQueue {
  private readonly values: unknown[] = [];
  private readonly waiters: Waiter[] = [];
  private closed = false;

  push(value: unknown): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter(value);
    else this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter(END);
  }

  async *iterate(signal?: AbortSignal): AsyncIterable<unknown> {
    while (!signal?.aborted) {
      const value = await this.take(signal);
      if (value === END) return;
      yield value;
    }
  }

  private take(signal?: AbortSignal): Promise<unknown | typeof END> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve(value);
    if (this.closed || signal?.aborted) return Promise.resolve(END);
    return new Promise((resolve) => {
      let waiter: Waiter;
      const abort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        signal?.removeEventListener("abort", abort);
        resolve(END);
      };
      signal?.addEventListener("abort", abort, { once: true });
      waiter = (next) => {
        signal?.removeEventListener("abort", abort);
        resolve(next);
      };
      this.waiters.push(waiter);
    });
  }
}

export class FakeNativeDshTransport implements NativeDshTransport {
  readonly requests: Request[] = [];
  closed = false;
  readonly host = new AsyncQueue();
  readonly journal = new AsyncQueue();

  constructor(
    private readonly sessionId = "runtime-session-1",
    private readonly catalog: unknown = {
      groups: [],
    },
    private readonly commands: unknown[] = [],
    private readonly providers: unknown[] = [],
  ) {
    // Pumps must observe an initial value before the runtime admits a prompt.
    this.host.push({ type: "initial" });
    this.journal.push({
      type: "event",
      event: { type: "snapshot", seq: 0, time: 0, data: {} },
    });
  }

  request(endpoint: string, args: Record<string, unknown>): Promise<unknown> {
    this.requests.push({ endpoint, args });
    switch (endpoint) {
      case "session/create":
        return Promise.resolve({ sessionId: this.sessionId });
      case "session/modelCatalog":
        return Promise.resolve(this.catalog);
      case "commands/list":
        return Promise.resolve(this.commands);
      case "llm/listConfigurableProviders":
        return Promise.resolve(this.providers);
      default:
        return Promise.resolve(undefined);
    }
  }

  follow(endpoint: string, _args: Record<string, unknown>, signal?: AbortSignal): AsyncIterable<unknown> {
    return (endpoint === "$events" ? this.host : this.journal).iterate(signal);
  }

  pushHost(value: unknown): void {
    this.host.push(value);
  }

  pushJournal(value: unknown): void {
    this.journal.push(value);
  }

  close(): Promise<void> {
    this.closed = true;
    this.host.close();
    this.journal.close();
    return Promise.resolve();
  }
}

export function requestFor(
  transport: FakeNativeDshTransport,
  endpoint: string,
): Request | undefined {
  return transport.requests.find((request) => request.endpoint === endpoint);
}

export function allRequestsFor(
  transport: FakeNativeDshTransport,
  endpoint: string,
): Request[] {
  return transport.requests.filter((request) => request.endpoint === endpoint);
}
