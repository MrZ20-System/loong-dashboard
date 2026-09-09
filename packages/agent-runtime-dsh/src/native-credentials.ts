import type { NativeDshTransport } from "./native-transport.js";

const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

type JsonObject = Record<string, unknown>;

/**
 * Store a provider secret through DSH's credential service and, when the
 * provider profile has no reference yet, bind the profile to the derived
 * reference first. The adapter deliberately talks to the public remote
 * faces through the transport rather than importing DSH settings types.
 */
export async function configureNativeCredential(
  transport: NativeDshTransport,
  provider: string,
  secret: string,
): Promise<void> {
  if (provider.trim().length === 0) {
    throw new Error("DSH credential provider must not be empty");
  }
  if (secret.length === 0) {
    throw new Error("DSH credential secret must not be empty");
  }

  const configurable = parseConfigurableProviders(
    await transport.request("llm/listConfigurableProviders", {}),
  );
  const target = configurable.find((entry) => entry.provider === provider);
  if (target === undefined) {
    throw new Error(`DSH provider "${provider}" has no configurable settings`);
  }

  const settings = asObject(
    await transport.request("settings/describe", {}),
    "settings/describe",
  );
  const namespaces = settings.namespaces;
  if (!Array.isArray(namespaces)) {
    throw new Error("DSH settings/describe returned no namespace list");
  }
  const namespace = namespaces.find((candidate) => {
    const value = asObjectOrUndefined(candidate);
    return value?.ns === target.settingsNs;
  });
  const namespaceObject = asObjectOrUndefined(namespace);
  if (namespaceObject === undefined) {
    throw new Error(`DSH settings namespace "${target.settingsNs}" is unavailable`);
  }

  const profile = readPath(namespaceObject.value, target.settingsPath);
  const currentRef =
    typeof asObjectOrUndefined(profile)?.apiKeyEnv === "string" &&
    (asObjectOrUndefined(profile)?.apiKeyEnv as string).length > 0
      ? (asObjectOrUndefined(profile)?.apiKeyEnv as string)
      : undefined;
  const ref = currentRef ?? deriveCredentialRef(provider);
  if (!CREDENTIAL_REF_PATTERN.test(ref)) {
    throw new Error(`DSH provider "${provider}" has an invalid credential reference`);
  }

  if (currentRef === undefined) {
    const revision = namespaceObject.revision;
    if (typeof revision !== "number" || !Number.isFinite(revision)) {
      throw new Error(`DSH settings namespace "${target.settingsNs}" has no revision`);
    }
    await transport.request("settings/mutate", {
      ns: target.settingsNs,
      ops: [{
        op: "set",
        path: [...target.settingsPath, "apiKeyEnv"],
        value: ref,
      }],
      expectedRevision: revision,
    });
  }

  // Keep the secret in DSH's credential store. It must never be copied into
  // settings, returned in an error, or placed in the process environment by
  // this helper.
  await transport.request("credentials/set", { ref, value: secret });
}

function deriveCredentialRef(provider: string): string {
  const stem = provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const ref = `${stem}_API_KEY`;
  return /^[A-Za-z_]/.test(ref) ? ref : `_${ref}`;
}

function parseConfigurableProviders(value: unknown): Array<{
  provider: string;
  settingsNs: string;
  settingsPath: string[];
}> {
  if (!Array.isArray(value)) {
    throw new Error("DSH llm/listConfigurableProviders returned an invalid list");
  }
  return value.map((candidate, index) => {
    const entry = asObjectOrUndefined(candidate);
    if (
      entry === undefined ||
      typeof entry.provider !== "string" ||
      typeof entry.settingsNs !== "string" ||
      !Array.isArray(entry.settingsPath) ||
      !entry.settingsPath.every((part) => typeof part === "string")
    ) {
      throw new Error(
        `DSH llm/listConfigurableProviders returned an invalid entry at index ${index}`,
      );
    }
    return {
      provider: entry.provider,
      settingsNs: entry.settingsNs,
      settingsPath: entry.settingsPath as string[],
    };
  });
}

function readPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const part of path) {
    const object = asObjectOrUndefined(current);
    if (object === undefined) return undefined;
    current = object[part];
  }
  return current;
}

function asObject(value: unknown, label: string): JsonObject {
  const object = asObjectOrUndefined(value);
  if (object === undefined) throw new Error(`DSH ${label} returned an invalid object`);
  return object;
}

function asObjectOrUndefined(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}
