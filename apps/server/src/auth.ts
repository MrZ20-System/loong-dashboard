import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";

import type { AuthStatus } from "@loongboard/contracts";

const AUTH_FILE_VERSION = 1;
const PASSWORD_HASH_BYTES = 32;
const PASSWORD_SALT_BYTES = 16;
const SIGNING_SECRET_BYTES = 32;
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const MAX_SESSION_TOKEN_LENGTH = 2_048;
const BACKOFF_BASE_MS = 250;
const BACKOFF_MAX_MS = 4_000;
const SCRYPT_OPTIONS: ScryptOptions = {
  N: 1 << 15,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
};
const DUMMY_SALT = "loongboard-auth-dummy-salt-v1";
const SESSION_COOKIE = "loongboard_session";

interface StoredAuthState {
  version: 1;
  enabled: boolean;
  salt: string;
  hash: string;
  signingSecret: string;
  authVersion: number;
  updatedAt: string;
}

export interface AuthServiceOptions {
  statePath?: string;
  filePath?: string;
  environment?: NodeJS.ProcessEnv;
  now?: () => Date;
  sessionTtlSeconds?: number;
}

export interface AuthMutationResult {
  status: AuthStatus;
  token: string | null;
}

export class AuthRequiredError extends Error {
  readonly code = "AUTH_REQUIRED" as const;

  constructor() {
    super("Authentication required");
    this.name = "AuthRequiredError";
  }
}

export class AuthInvalidPasswordError extends Error {
  readonly code = "AUTH_INVALID_PASSWORD" as const;

  constructor() {
    super("Invalid password");
    this.name = "AuthInvalidPasswordError";
  }
}

export class AuthRateLimitedError extends Error {
  readonly code = "AUTH_RATE_LIMITED" as const;
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("Too many failed password attempts; try again shortly");
    this.name = "AuthRateLimitedError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Small file-backed password lock; it never participates in data encryption. */
export class AuthService {
  readonly filePath: string | undefined;
  private readonly now: () => Date;
  private readonly sessionTtlSeconds: number;
  private readonly secureCookieByEnvironment: boolean;
  private state: StoredAuthState | undefined;
  private failedAttempts = 0;
  private backoffUntil = 0;

  constructor(options: AuthServiceOptions = {}) {
    const filePath = options.filePath ??
      (options.statePath === undefined ? undefined : join(options.statePath, "auth.json"));
    this.filePath = filePath === undefined ? undefined : validateAuthFilePath(filePath);
    this.now = options.now ?? (() => new Date());
    this.sessionTtlSeconds = options.sessionTtlSeconds ?? SESSION_TTL_SECONDS;
    if (!Number.isInteger(this.sessionTtlSeconds) || this.sessionTtlSeconds < 60) {
      throw new Error("sessionTtlSeconds must be at least 60 seconds");
    }
    const environment = options.environment ?? process.env;
    this.secureCookieByEnvironment = isTruthy(environment.LOONGBOARD_HTTPS) ||
      isTruthy(environment.LOONGBOARD_SERVER_HTTPS) ||
      isTruthy(environment.LOONGBOARD_TLS);
    this.state = this.filePath === undefined ? undefined : readAuthState(this.filePath);
  }

  /** Build an in-memory OFF service for embedded/test apps without a state root. */
  static disabled(options: Omit<AuthServiceOptions, "filePath" | "statePath"> = {}): AuthService {
    return new AuthService(options);
  }

  isEnabled(): boolean {
    return this.state?.enabled === true;
  }

  status(cookieHeader?: string): AuthStatus {
    if (!this.isEnabled()) return { enabled: false, unlocked: true };
    return { enabled: true, unlocked: this.isAuthorized(cookieHeader) };
  }

  isAuthorized(cookieHeader?: string): boolean {
    if (!this.isEnabled()) return true;
    const token = readCookie(cookieHeader, SESSION_COOKIE);
    return token !== null && this.verifyToken(token);
  }

  requireAuthorized(cookieHeader?: string): void {
    if (!this.isAuthorized(cookieHeader)) throw new AuthRequiredError();
  }

  async unlock(password: string): Promise<AuthMutationResult> {
    this.validatePassword(password);
    const state = this.state;
    if (state === undefined || !state.enabled) {
      // Keep the off/incorrect path similarly expensive without storing a
      // password or exposing whether a lock file exists.
      await derivePassword(password, DUMMY_SALT);
      return { status: { enabled: false, unlocked: true }, token: null };
    }
    this.assertBackoff();
    const valid = await this.passwordMatches(state, password);
    if (!valid) {
      this.recordFailure();
      throw new AuthInvalidPasswordError();
    }
    this.clearFailures();
    const token = this.issueToken(state);
    return { status: { enabled: true, unlocked: true }, token };
  }

  async setPassword(password: string, cookieHeader?: string, currentPassword?: string): Promise<AuthMutationResult> {
    this.validatePassword(password);
    if (this.isEnabled()) {
      this.requireAuthorized(cookieHeader);
      if (currentPassword !== undefined) {
        this.validatePassword(currentPassword);
        this.assertBackoff();
        if (!(await this.passwordMatches(this.state!, currentPassword))) {
          this.recordFailure();
          throw new AuthInvalidPasswordError();
        }
      }
    }
    const next = await this.createState(password, true);
    this.state = next;
    this.clearFailures();
    const token = this.issueToken(next);
    return { status: { enabled: true, unlocked: true }, token };
  }

  async disable(cookieHeader?: string): Promise<AuthMutationResult> {
    if (!this.isEnabled()) return { status: { enabled: false, unlocked: true }, token: null };
    this.requireAuthorized(cookieHeader);
    const state = this.state!;
    const next: StoredAuthState = {
      ...state,
      enabled: false,
      // Rotate both values so a copied token or old state cannot be reused if
      // the same file is enabled again later.
      signingSecret: randomBytes(SIGNING_SECRET_BYTES).toString("base64url"),
      authVersion: state.authVersion + 1,
      updatedAt: this.timestamp(),
    };
    this.writeState(next);
    this.state = next;
    this.clearFailures();
    return { status: { enabled: false, unlocked: true }, token: null };
  }

  sessionCookie(token: string, secure = false): string {
    const attributes = [
      `${SESSION_COOKIE}=${token}`,
      `Max-Age=${this.sessionTtlSeconds}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
    ];
    if (secure || this.secureCookieByEnvironment) attributes.push("Secure");
    return attributes.join("; ");
  }

  clearSessionCookie(secure = false): string {
    const attributes = [
      `${SESSION_COOKIE}=`,
      "Max-Age=0",
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
    ];
    if (secure || this.secureCookieByEnvironment) attributes.push("Secure");
    return attributes.join("; ");
  }

  private async createState(password: string, enabled: boolean): Promise<StoredAuthState> {
    const salt = randomBytes(PASSWORD_SALT_BYTES).toString("base64url");
    const hash = (await derivePassword(password, salt)).toString("base64url");
    const priorVersion = this.state?.authVersion ?? 0;
    const next: StoredAuthState = {
      version: AUTH_FILE_VERSION,
      enabled,
      salt,
      hash,
      signingSecret: randomBytes(SIGNING_SECRET_BYTES).toString("base64url"),
      authVersion: priorVersion + 1,
      updatedAt: this.timestamp(),
    };
    this.writeState(next);
    return next;
  }

  private writeState(next: StoredAuthState): void {
    if (this.filePath === undefined) throw new Error("Auth state path is not configured");
    atomicWriteAuthState(this.filePath, next);
  }

  private async passwordMatches(state: StoredAuthState, password: string): Promise<boolean> {
    const expected = decodeSecret(state.hash);
    const actual = await derivePassword(password, state.salt);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private issueToken(state: StoredAuthState): string {
    const issuedAt = Math.floor(this.clockMillis() / 1_000);
    const payload = encodeBase64Url(JSON.stringify({
      authVersion: state.authVersion,
      expiresAt: issuedAt + this.sessionTtlSeconds,
      issuedAt,
    }));
    const signature = createHmac("sha256", decodeSecret(state.signingSecret))
      .update(payload)
      .digest("base64url");
    return `${payload}.${signature}`;
  }

  private verifyToken(token: string): boolean {
    if (token.length === 0 || token.length > MAX_SESSION_TOKEN_LENGTH) return false;
    const state = this.state;
    if (state === undefined || !state.enabled) return false;
    const [payload, signature, ...extra] = token.split(".");
    if (!payload || !signature || extra.length > 0) return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      return false;
    }
    if (!isTokenPayload(parsed)) return false;
    const expected = createHmac("sha256", decodeSecret(state.signingSecret))
      .update(payload)
      .digest();
    let provided: Buffer;
    try {
      provided = Buffer.from(signature, "base64url");
    } catch {
      return false;
    }
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return false;
    const now = Math.floor(this.clockMillis() / 1_000);
    return parsed.authVersion === state.authVersion && parsed.issuedAt <= now && parsed.expiresAt > now;
  }

  private assertBackoff(): void {
    const remaining = this.backoffUntil - this.clockMillis();
    if (remaining > 0) throw new AuthRateLimitedError(Math.max(1, Math.ceil(remaining / 1_000)));
  }

  private recordFailure(): void {
    this.failedAttempts += 1;
    const delay = Math.min(
      BACKOFF_MAX_MS,
      BACKOFF_BASE_MS * 2 ** Math.min(this.failedAttempts - 1, 6),
    );
    this.backoffUntil = this.clockMillis() + delay;
  }

  private clearFailures(): void {
    this.failedAttempts = 0;
    this.backoffUntil = 0;
  }

  private validatePassword(password: string): void {
    if (typeof password !== "string" || password.length === 0 || password.length > 1_024) {
      throw new Error("Password must contain between 1 and 1024 characters");
    }
  }

  private timestamp(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("Invalid auth clock");
    return value.toISOString();
  }

  private clockMillis(): number {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("Invalid auth clock");
    return value.getTime();
  }
}

export function authFilePath(statePath: string): string {
  return validateAuthFilePath(join(statePath, "auth.json"));
}

/** Disable recovery by removing exactly statePath/auth.json and nothing else. */
export function resetAuthFile(filePath: string): boolean {
  const validated = validateAuthFilePath(filePath);
  let stat;
  try {
    stat = lstatSync(validated);
  } catch (error: unknown) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
  if (!stat.isFile()) throw new Error("Auth reset target is not a regular file");
  const parentStat = lstatSync(dirname(validated));
  if (!parentStat.isDirectory()) throw new Error("Auth reset parent is not a directory");
  unlinkSync(validated);
  return true;
}

function validateAuthFilePath(filePath: string): string {
  const absolute = resolve(filePath);
  if (!isAbsolute(filePath) || basename(absolute) !== "auth.json") {
    throw new Error("Auth file path must be an absolute auth.json path");
  }
  return absolute;
}

function readAuthState(filePath: string): StoredAuthState | undefined {
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch (error: unknown) {
    if (isMissingFileError(error)) return undefined;
    throw new Error("Invalid auth state");
  }
  if (!stat.isFile()) throw new Error("Invalid auth state");
  const parentStat = lstatSync(dirname(filePath));
  if (!parentStat.isDirectory()) throw new Error("Invalid auth state");
  // Existing files may come from an older launch; tighten permissions before
  // parsing so the live process never leaves credentials readable by others.
  chmodSync(dirname(filePath), 0o700);
  chmodSync(filePath, 0o600);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    throw new Error("Invalid auth state");
  }
  if (!isStoredAuthState(parsed)) throw new Error("Invalid auth state");
  return parsed;
}

function isStoredAuthState(value: unknown): value is StoredAuthState {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<StoredAuthState>;
  return candidate.version === AUTH_FILE_VERSION &&
    typeof candidate.enabled === "boolean" &&
    typeof candidate.salt === "string" &&
    typeof candidate.hash === "string" &&
    typeof candidate.signingSecret === "string" &&
    Number.isInteger(candidate.authVersion) && (candidate.authVersion ?? 0) > 0 &&
    typeof candidate.updatedAt === "string" && Number.isFinite(Date.parse(candidate.updatedAt)) &&
    decodeSecret(candidate.salt).length >= PASSWORD_SALT_BYTES &&
    decodeSecret(candidate.hash).length === PASSWORD_HASH_BYTES &&
    decodeSecret(candidate.signingSecret).length >= SIGNING_SECRET_BYTES;
}

function decodeSecret(value: string): Buffer {
  try {
    return Buffer.from(value, "base64url");
  } catch {
    return Buffer.alloc(0);
  }
}

function derivePassword(password: string, salt: string): Promise<Buffer> {
  return new Promise<Buffer>((resolvePromise, reject) => {
    scrypt(password, salt, PASSWORD_HASH_BYTES, SCRYPT_OPTIONS, (error, derivedKey) => {
      if (error) reject(error);
      else resolvePromise(derivedKey as Buffer);
    });
  });
}

function isTokenPayload(value: unknown): value is {
  authVersion: number;
  expiresAt: number;
  issuedAt: number;
} {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const authVersion = candidate.authVersion;
  const issuedAt = candidate.issuedAt;
  const expiresAt = candidate.expiresAt;
  if (Object.keys(candidate).length !== 3 ||
      typeof authVersion !== "number" ||
      typeof issuedAt !== "number" ||
      typeof expiresAt !== "number") return false;
  return Number.isSafeInteger(authVersion) &&
    Number.isSafeInteger(issuedAt) &&
    Number.isSafeInteger(expiresAt) &&
    expiresAt > issuedAt;
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  return null;
}

function atomicWriteAuthState(filePath: string, state: StoredAuthState): void {
  const parent = dirname(filePath);
  ensureAuthParent(parent);
  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const content = `${JSON.stringify(state)}\n`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeSync(descriptor, content, undefined, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, filePath);
    chmodSync(filePath, 0o600);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Best effort cleanup; preserve the original failure.
    }
    throw error;
  }
}

function ensureAuthParent(parent: string): void {
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stat = lstatSync(parent);
  if (!stat.isDirectory()) throw new Error("Auth state parent is not a directory");
  chmodSync(parent, 0o700);
}

function isMissingFileError(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function isTruthy(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}
