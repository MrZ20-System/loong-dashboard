import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { execa } from "execa";

/** Sources understood by the shared GitHub credential resolver. */
export type GitHubCredentialSource =
  | "settings"
  | "GH_TOKEN"
  | "GITHUB_TOKEN"
  | "gh"
  | "none";

export interface GitHubCredentialSummary {
  configured: boolean;
  source: GitHubCredentialSource;
}

export interface GitHubCredentialServiceOptions {
  /** A private file below the LoongBoard state directory. */
  filePath: string;
  environment?: NodeJS.ProcessEnv;
  ghExecutable?: string;
  commandTimeoutMs?: number;
}

interface StoredCredential {
  version: 1;
  token: string;
}

/**
 * One credential boundary for GitHub HTTP and `gh`-backed operations.
 *
 * The token is intentionally only exposed through `storedToken()` to the
 * provider's injected resolver. HTTP handlers consume `summary()` and never
 * receive the token. The file is private to the local user (0600) and is not
 * part of settings JSON, Knowledge history, or Agent workspace state.
 */
export class GitHubCredentialService {
  readonly filePath: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly ghExecutable: string;
  private readonly commandTimeoutMs: number;

  constructor(options: GitHubCredentialServiceOptions) {
    if (options.filePath.trim().length === 0) {
      throw new Error("GitHub credential file path must not be empty");
    }
    this.filePath = options.filePath;
    this.environment = options.environment ?? process.env;
    this.ghExecutable = options.ghExecutable ?? "gh";
    this.commandTimeoutMs = options.commandTimeoutMs ?? 120_000;
    if (this.ghExecutable.trim().length === 0) {
      throw new Error("GitHub gh executable must not be empty");
    }
    if (!Number.isInteger(this.commandTimeoutMs) || this.commandTimeoutMs <= 0) {
      throw new Error("GitHub credential command timeout must be positive");
    }
  }

  /** Read the persisted token for the provider; never call this from HTTP. */
  storedToken(): string | null {
    if (!existsSync(this.filePath)) return null;
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch (error) {
      throw new Error(
        `Failed to read GitHub credential file ${this.filePath}: ${reason(error)}`,
      );
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new Error(
        `GitHub credential file is invalid JSON at ${this.filePath}`,
      );
    }
    if (!isStoredCredential(decoded)) {
      throw new Error(`GitHub credential file has an invalid shape: ${this.filePath}`);
    }
    return decoded.token;
  }

  /** Stable source/configuration projection for settings views. */
  async summary(): Promise<GitHubCredentialSummary> {
    if (this.storedToken() !== null) {
      return { configured: true, source: "settings" };
    }
    if (nonEmpty(this.environment.GH_TOKEN)) {
      return { configured: true, source: "GH_TOKEN" };
    }
    if (nonEmpty(this.environment.GITHUB_TOKEN)) {
      return { configured: true, source: "GITHUB_TOKEN" };
    }
    try {
      await this.resolveGhToken();
      return { configured: true, source: "gh" };
    } catch {
      return { configured: false, source: "none" };
    }
  }

  /** Resolve one usable token while keeping the source inside this service. */
  async resolve(): Promise<{ token: string; source: GitHubCredentialSource }> {
    const stored = this.storedToken();
    if (stored !== null) return { token: stored, source: "settings" };
    const ghToken = nonEmpty(this.environment.GH_TOKEN)
      ? this.environment.GH_TOKEN.trim()
      : null;
    if (ghToken !== null) return { token: ghToken, source: "GH_TOKEN" };
    const githubToken = nonEmpty(this.environment.GITHUB_TOKEN)
      ? this.environment.GITHUB_TOKEN.trim()
      : null;
    if (githubToken !== null) {
      return { token: githubToken, source: "GITHUB_TOKEN" };
    }
    return { token: await this.resolveGhToken(), source: "gh" };
  }

  /** Resolver suitable for `GhGitHubMetadataProvider` options. */
  resolveToken(): Promise<string> {
    return this.resolve().then(({ token }) => token);
  }

  /** Persist/replace a token without exposing it to callers. */
  save(token: string): void {
    const normalized = token.trim();
    if (normalized.length === 0) {
      throw new Error("GitHub token must not be empty");
    }
    const directory = dirname(this.filePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = join(
      directory,
      `.${this.filePath.split(/[\\/]/).at(-1) ?? "github-credential"}.tmp-${process.pid}-${Date.now()}`,
    );
    try {
      writeFileSync(
        temporaryPath,
        `${JSON.stringify({ version: 1, token: normalized } satisfies StoredCredential)}\n`,
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
      chmodSync(temporaryPath, 0o600);
      renameSync(temporaryPath, this.filePath);
      chmodSync(this.filePath, 0o600);
    } catch (error) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // Preserve the original write error.
      }
      throw new Error(
        `Failed to save GitHub credential at ${this.filePath}: ${reason(error)}`,
      );
    }
  }

  remove(): boolean {
    if (!existsSync(this.filePath)) return false;
    try {
      unlinkSync(this.filePath);
      return true;
    } catch (error) {
      throw new Error(
        `Failed to remove GitHub credential at ${this.filePath}: ${reason(error)}`,
      );
    }
  }

  private async resolveGhToken(): Promise<string> {
    const env = { ...this.environment };
    const inheritedToken = nonEmpty(env.GH_TOKEN)
      ? env.GH_TOKEN
      : nonEmpty(env.GITHUB_TOKEN)
        ? env.GITHUB_TOKEN
        : undefined;
    if (inheritedToken !== undefined) env.GH_TOKEN = inheritedToken;
    const result = await execa(this.ghExecutable, ["auth", "token"], {
      shell: false,
      reject: false,
      timeout: this.commandTimeoutMs,
      maxBuffer: 1024 * 1024,
      env,
    });
    if (result.failed || result.exitCode !== 0 || !nonEmpty(result.stdout)) {
      throw new Error("GitHub authentication is not configured");
    }
    return result.stdout.trim();
  }
}

function isStoredCredential(value: unknown): value is StoredCredential {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<StoredCredential>;
  return candidate.version === 1 && nonEmpty(candidate.token);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
