import { describe, expect, it } from "vitest";

import { configureNativeCredential } from "../src/native-credentials.js";
import type { NativeDshTransport } from "../src/native-transport.js";

type Call = { endpoint: string; args: Record<string, unknown> };

class CredentialTransport implements NativeDshTransport {
  readonly calls: Call[] = [];

  constructor(private readonly settingsValue: unknown) {}

  request(endpoint: string, args: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ endpoint, args });
    if (endpoint === "llm/listConfigurableProviders") {
      return Promise.resolve([
        {
          provider: "openai-compatible",
          displayName: "Gateway",
          settingsNs: "llm-pi-ai",
          settingsPath: ["providers", "gateway"],
        },
      ]);
    }
    if (endpoint === "settings/describe") {
      return Promise.resolve({
        writable: true,
        hasDocument: true,
        namespaces: [{
          ns: "llm-pi-ai",
          value: this.settingsValue,
          revision: 7,
        }],
      });
    }
    return Promise.resolve(undefined);
  }

  follow(): AsyncIterable<unknown> {
    return (async function* () {})();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

describe("configureNativeCredential", () => {
  it("reuses a profile reference and stores the value only through credentials/set", async () => {
    const transport = new CredentialTransport({
      providers: { gateway: { apiKeyEnv: "GATEWAY_SECRET" } },
    });

    await configureNativeCredential(transport, "openai-compatible", "secret-value");

    expect(transport.calls).toEqual([
      { endpoint: "llm/listConfigurableProviders", args: {} },
      { endpoint: "settings/describe", args: {} },
      {
        endpoint: "credentials/set",
        args: { ref: "GATEWAY_SECRET", value: "secret-value" },
      },
    ]);
  });

  it("derives the DSH reference and binds it with the current revision before storing", async () => {
    const transport = new CredentialTransport({ providers: { gateway: {} } });

    await configureNativeCredential(transport, "openai-compatible", "secret-value");

    expect(transport.calls.slice(2)).toEqual([
      {
        endpoint: "settings/mutate",
        args: {
          ns: "llm-pi-ai",
          ops: [{
            op: "set",
            path: ["providers", "gateway", "apiKeyEnv"],
            value: "OPENAI_COMPATIBLE_API_KEY",
          }],
          expectedRevision: 7,
        },
      },
      {
        endpoint: "credentials/set",
        args: { ref: "OPENAI_COMPATIBLE_API_KEY", value: "secret-value" },
      },
    ]);
  });
});
