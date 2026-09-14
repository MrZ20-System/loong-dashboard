import { mkdir, mkdtemp, rm, rename, writeFile, chmod, lstat, realpath, readdir, readFile, rmdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, relative, resolve, sep, join } from "node:path";

import { GitCommandError, runGitText, type RunGitOptions } from "./git-command.js";

const DEFAULT_ONBOARDING_TIMEOUT_MS = 10 * 60 * 1000;
const repositoryTargetLocks = new Map<string, Promise<unknown>>();
const ASKPASS_SCRIPT = `#!/bin/sh
case "$1" in
  *[Uu]sername*) printf '%s\\n' "$LOONGBOARD_ONBOARDING_USERNAME" ;;
  *) printf '%s\\n' "$LOONGBOARD_ONBOARDING_PASSWORD" ;;
esac
`;

export interface RepositoryCredential {
  readonly username?: string;
  readonly password?: string;
  readonly token?: string;
}

export type RepositoryCredentialProvider =
  () => RepositoryCredential | undefined | Promise<RepositoryCredential | undefined>;

export interface RepositoryOnboardingInput {
  readonly cloneUrl: string;
  readonly owner: string;
  readonly name: string;
  readonly remoteName: string;
  readonly defaultBranch: string;
  readonly targetPath: string;
  readonly managedRoot: string;
  /** Credentials are passed to Git only through a temporary askpass process environment. */
  readonly credential?: RepositoryCredentialProvider;
}

export interface RepositoryOnboardingOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Permit an existing directory only when it is still empty at install time. */
  readonly allowEmptyTarget?: boolean;
  /** Validate the private staging checkout before it is installed at targetPath. */
  readonly validateStagedRepository?: (stagingPath: string) => void | Promise<void>;
}

interface FileIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly size: string;
  readonly mtimeMs: string;
  readonly mode: string;
}

interface InstallationClaim {
  readonly targetPath: string;
  readonly target: FileIdentity;
  readonly markerPath: string;
  readonly token: string;
  marker?: FileIdentity;
  readonly movedEntries: Map<string, FileIdentity>;
}

export interface RepositoryInspection {
  readonly action: "adopted";
  readonly targetPath: string;
  readonly owner: string;
  readonly name: string;
  readonly remoteName: string;
  readonly defaultBranch: string;
  readonly remoteMatched: true;
  readonly defaultBranchAvailable: true;
}

export interface RepositoryCloneResult {
  readonly action: "cloned";
  readonly targetPath: string;
  readonly owner: string;
  readonly name: string;
  readonly remoteName: string;
  readonly defaultBranch: string;
  readonly remoteMatched: true;
  readonly defaultBranchAvailable: true;
}

export type RepositoryEnsureResult = RepositoryInspection | RepositoryCloneResult;

export type RepositoryOnboardingErrorCode =
  | "invalid_input"
  | "unsafe_path"
  | "target_exists"
  | "not_git_repository"
  | "remote_missing"
  | "remote_mismatch"
  | "default_branch_missing"
  | "clone_failed"
  | "canceled";

export class RepositoryOnboardingError extends Error {
  readonly code: RepositoryOnboardingErrorCode;
  readonly targetPath: string;

  constructor(code: RepositoryOnboardingErrorCode, message: string, targetPath: string) {
    super(message);
    this.name = "RepositoryOnboardingError";
    this.code = code;
    this.targetPath = targetPath;
  }
}

export interface RepositoryGitRunner {
  runText(repositoryPath: string, args: readonly string[], options?: RunGitOptions): Promise<string>;
}

export interface RepositoryOnboardingGitOptions {
  readonly runner?: RepositoryGitRunner;
  readonly timeoutMs?: number;
  /** Filesystem seam used by focused tests to inject an install failure. */
  readonly renameEntry?: (sourcePath: string, destinationPath: string) => Promise<void>;
}

const defaultRunner: RepositoryGitRunner = { runText: runGitText };

function assertNotAborted(signal: AbortSignal | undefined, targetPath: string): void {
  if (signal?.aborted === true) {
    throw new RepositoryOnboardingError("canceled", "Repository onboarding was canceled", targetPath);
  }
}

function fail(code: RepositoryOnboardingErrorCode, message: string, targetPath: string): never {
  throw new RepositoryOnboardingError(code, message, targetPath);
}

function fileIdentity(stat: Awaited<ReturnType<typeof lstat>>): FileIdentity {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: String(stat.size),
    mtimeMs: String(stat.mtimeMs),
    mode: String(stat.mode),
  };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.mode === right.mode;
}

function sameObjectIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function validateInput(input: RepositoryOnboardingInput): void {
  for (const [key, value] of Object.entries(input)) {
    if (key === "credential") continue;
    if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
      fail("invalid_input", `Repository ${key} is invalid`, input.targetPath);
    }
  }
  for (const value of [input.owner, input.name, input.remoteName, input.defaultBranch]) {
    if (value.startsWith("-") || value.includes("\\") || value.includes("..") || value.includes("@{")) {
      fail("invalid_input", "Repository identifier is invalid", input.targetPath);
    }
  }
  if (input.remoteName.includes("/") || input.remoteName.includes(" ")) {
    fail("invalid_input", "Repository remote name is invalid", input.targetPath);
  }
  const requested = repositoryIdentity(input.cloneUrl);
  if (requested === null || requested.kind !== "github") {
    fail("invalid_input", "Repository clone URL must be a GitHub HTTPS or SSH URL", input.targetPath);
  }
  if (requested.owner !== input.owner.toLowerCase() || requested.name !== input.name.toLowerCase()) {
    fail("invalid_input", "Repository clone URL does not match the requested repository", input.targetPath);
  }
}

type RepositoryIdentity = { kind: "github"; owner: string; name: string };

function repositoryIdentity(value: string): RepositoryIdentity | null {
  const trimmed = value.trim();
  const scp = /^git@github\.com:([^/]+)\/([^/?#]+)$/i.exec(trimmed);
  if (scp !== null) {
    return { kind: "github", owner: scp[1]!.toLowerCase(), name: scp[2]!.replace(/\.git$/, "").toLowerCase() };
  }
  try {
    // WHATWG URL drops default ports (for example :443), but an explicit
    // port is not an approved GitHub clone form and must still be rejected.
    if (/^[a-z][a-z\d+.-]*:\/\/[^/?#]*:\d+(?:[/?#]|$)/i.test(trimmed)) return null;
    const parsed = new URL(trimmed);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") ||
      parsed.hostname.toLowerCase() !== "github.com" ||
      parsed.port.length > 0 ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0 ||
      parsed.password.length > 0 ||
      (parsed.protocol === "https:" && parsed.username.length > 0) ||
      (parsed.protocol === "ssh:" && parsed.username !== "git")
    ) return null;
    const path = parsed.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
    const parts = path.split("/");
    if (parts.length === 2 && parts.every(Boolean)) {
      return { kind: "github", owner: parts[0]!.toLowerCase(), name: parts[1]!.toLowerCase() };
    }
    return null;
  } catch {
    return null;
  }
}

function expectedIdentity(input: RepositoryOnboardingInput): RepositoryIdentity {
  const fromUrl = repositoryIdentity(input.cloneUrl);
  if (fromUrl?.kind === "github" && fromUrl.owner === input.owner.toLowerCase() && fromUrl.name === input.name.toLowerCase()) return fromUrl;
  fail("invalid_input", "Repository clone URL is invalid", input.targetPath);
}

function identityMatches(actual: RepositoryIdentity | null, expected: RepositoryIdentity): boolean {
  if (actual === null || actual.kind !== expected.kind) return false;
  return actual.owner === expected.owner && actual.name === expected.name;
}

async function pathInsideManagedRoot(
  input: RepositoryOnboardingInput,
  mustExist: boolean,
  createRoot = false,
): Promise<{ root: string; target: string }> {
  const configuredRoot = resolve(input.managedRoot);
  let root: string;
  try {
    const rootStat = await lstat(configuredRoot);
    if (rootStat.isSymbolicLink()) fail("unsafe_path", "Managed repository root must not be a symlink", input.targetPath);
    root = await realpath(configuredRoot);
  } catch (error) {
    if (error instanceof RepositoryOnboardingError) throw error;
    if (!createRoot || (error as NodeJS.ErrnoException).code !== "ENOENT") {
      fail("unsafe_path", "Managed repository root is unavailable", input.targetPath);
    }
    try {
      await mkdir(configuredRoot, { recursive: true, mode: 0o750 });
      const rootStat = await lstat(configuredRoot);
      if (rootStat.isSymbolicLink()) fail("unsafe_path", "Managed repository root must not be a symlink", input.targetPath);
      root = await realpath(configuredRoot);
    } catch (createError) {
      if (createError instanceof RepositoryOnboardingError) throw createError;
      fail("unsafe_path", "Managed repository root could not be created", input.targetPath);
    }
  }
  const target = resolve(input.targetPath);
  const rel = relative(root, target);
  if (rel.length === 0) {
    fail("unsafe_path", "Repository target must be inside the managed root", input.targetPath);
  }
  if (mustExist) {
    let targetReal: string;
    try {
      targetReal = await realpath(target);
    } catch {
      fail("target_exists", "Repository target does not exist", input.targetPath);
    }
    const targetRel = relative(root, targetReal);
    if (targetRel === ".." || targetRel.startsWith(`..${sep}`) || isAbsolute(targetRel)) {
      fail("unsafe_path", "Repository target escapes the managed root", input.targetPath);
    }
    return { root, target };
  }
  const parent = dirname(target);
  try {
    await mkdir(parent, { recursive: true });
    const parentReal = await realpath(parent);
    const parentRel = relative(root, parentReal);
    if (parentRel === ".." || parentRel.startsWith(`..${sep}`) || isAbsolute(parentRel)) {
      fail("unsafe_path", "Repository target parent escapes the managed root", input.targetPath);
    }
  } catch (error) {
    if (error instanceof RepositoryOnboardingError) throw error;
    fail("unsafe_path", "Repository target parent is unavailable", input.targetPath);
  }
  return { root, target };
}

async function targetState(target: string): Promise<"missing" | "existing" | "symlink"> {
  try {
    const info = await lstat(target);
    return info.isSymbolicLink() ? "symlink" : "existing";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

function mapGitFailure(
  code: RepositoryOnboardingErrorCode,
  operation: string,
  targetPath: string,
  error: unknown,
  signal?: AbortSignal,
): never {
  if (error instanceof RepositoryOnboardingError) throw error;
  if (signal?.aborted === true) {
    throw new RepositoryOnboardingError("canceled", "Repository onboarding was canceled", targetPath);
  }
  // Do not include stderr, args, or URLs. Git may echo credentials supplied by
  // a remote helper despite our askpass isolation.
  const exitCode = error instanceof GitCommandError && error.exitCode !== null ? ` (exit ${error.exitCode})` : "";
  fail(code, `Git ${operation} failed${exitCode}`, targetPath);
}

/**
 * Git reports a missing `clone --branch` ref with a stable, narrow stderr
 * sentence. Keep this classifier tied to GitCommandError and the requested
 * branch so network, authentication, and other clone failures stay generic.
 */
function isMissingDefaultBranchCloneError(
  error: unknown,
  defaultBranch: string,
): boolean {
  if (!(error instanceof GitCommandError)) return false;
  const escapedBranch = defaultBranch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?:^|\\n)fatal:\\s*remote branch\\s+${escapedBranch}\\s+not found in upstream\\s+[^\\r\\n]+`,
    "i",
  ).test(error.stderr);
}

function mapCloneFailure(
  input: RepositoryOnboardingInput,
  targetPath: string,
  error: unknown,
  signal?: AbortSignal,
): never {
  if (isMissingDefaultBranchCloneError(error, input.defaultBranch)) {
    fail(
      "default_branch_missing",
      `Git repository default branch "${input.defaultBranch}" does not exist on the remote`,
      targetPath,
    );
  }
  mapGitFailure("clone_failed", "repository clone", targetPath, error, signal);
}

function resultBase(input: RepositoryOnboardingInput, targetPath: string) {
  return {
    targetPath,
    owner: input.owner,
    name: input.name,
    remoteName: input.remoteName,
    defaultBranch: input.defaultBranch,
    remoteMatched: true as const,
    defaultBranchAvailable: true as const,
  };
}

export class RepositoryOnboardingGit {
  private readonly runner: RepositoryGitRunner;
  private readonly timeoutMs: number;
  private readonly renameEntry: (sourcePath: string, destinationPath: string) => Promise<void>;

  constructor(options: RepositoryOnboardingGitOptions = {}) {
    this.runner = options.runner ?? defaultRunner;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_ONBOARDING_TIMEOUT_MS;
    this.renameEntry = options.renameEntry ?? rename;
  }

  private async serialized<T>(targetPath: string, operation: () => Promise<T>): Promise<T> {
    const previous = repositoryTargetLocks.get(targetPath) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    repositoryTargetLocks.set(targetPath, current);
    try {
      return await current;
    } finally {
      if (repositoryTargetLocks.get(targetPath) === current) repositoryTargetLocks.delete(targetPath);
    }
  }

  private commandOptions(options: RepositoryOnboardingOptions, env?: NodeJS.ProcessEnv): RunGitOptions {
    return {
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(env === undefined ? {} : { env }),
    };
  }

  private async cleanupOwnedTarget(claim: InstallationClaim | undefined): Promise<void> {
    if (claim === undefined) return;
    try {
      const targetStat = await lstat(claim.targetPath);
      if (!sameObjectIdentity(fileIdentity(targetStat), claim.target) || !targetStat.isDirectory()) return;
      const entries = await readdir(claim.targetPath);
      const markerExists = entries.includes(claim.markerPath.split(sep).at(-1)!);
      if (claim.marker === undefined) {
        if (entries.length !== 0) return;
      } else {
        if (!markerExists) return;
        const markerStat = await lstat(claim.markerPath);
        if (!sameFileIdentity(fileIdentity(markerStat), claim.marker)) return;
        const token = await readFile(claim.markerPath, "utf8");
        if (token !== `${claim.token}\n`) return;
      }
      const markerName = claim.markerPath.split(sep).at(-1)!;
      for (const entry of entries) {
        if (entry !== markerName && !claim.movedEntries.has(entry)) return;
      }
      for (const [entry, identity] of claim.movedEntries) {
        const entryPath = join(claim.targetPath, entry);
        const entryStat = await lstat(entryPath);
        if (!sameFileIdentity(fileIdentity(entryStat), identity)) return;
      }
      await rm(claim.targetPath, { recursive: true, force: true });
    } catch {
      // Cleanup is best effort. If ownership cannot be proven, preserve the
      // target and let the caller report the original onboarding failure.
    }
  }

  /** Restore an initially empty caller-owned directory after an install error. */
  private async restoreEmptyTarget(targetPath: string): Promise<void> {
    try {
      if (await targetState(targetPath) !== "missing") return;
      const parent = dirname(targetPath);
      const parentStat = await lstat(parent);
      if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) return;
      await mkdir(targetPath);
    } catch {
      // Restoration is best effort and must never replace a concurrent target.
    }
  }

  private async inspectUnsafe(input: RepositoryOnboardingInput, options: RepositoryOnboardingOptions): Promise<RepositoryInspection> {
    validateInput(input);
    const location = await pathInsideManagedRoot(input, true);
    assertNotAborted(options.signal, location.target);
    const expected = expectedIdentity(input);
    try {
      const worktree = (await this.runner.runText(location.target, ["rev-parse", "--is-inside-work-tree"], this.commandOptions(options))).trim();
      if (worktree !== "true") fail("not_git_repository", "Repository target is not a Git worktree", location.target);
    } catch (error) {
      if (error instanceof RepositoryOnboardingError) throw error;
      mapGitFailure("not_git_repository", "repository inspection", location.target, error, options.signal);
    }
    let remoteUrl: string;
    try {
      remoteUrl = (await this.runner.runText(location.target, ["remote", "get-url", input.remoteName], this.commandOptions(options))).trim();
    } catch (error) {
      mapGitFailure("remote_missing", "remote inspection", location.target, error, options.signal);
    }
    if (!identityMatches(repositoryIdentity(remoteUrl), expected)) {
      fail("remote_mismatch", "Repository remote does not match the requested repository", location.target);
    }
    try {
      await this.runner.runText(location.target, ["show-ref", "--verify", "--quiet", `refs/remotes/${input.remoteName}/${input.defaultBranch}`], this.commandOptions(options));
    } catch (error) {
      mapGitFailure("default_branch_missing", "default branch inspection", location.target, error, options.signal);
    }
    assertNotAborted(options.signal, location.target);
    return { action: "adopted", ...resultBase(input, location.target) };
  }

  async inspect(input: RepositoryOnboardingInput, options: RepositoryOnboardingOptions = {}): Promise<RepositoryInspection> {
    return this.serialized(resolve(input.targetPath), () => this.inspectUnsafe(input, options));
  }

  async adopt(input: RepositoryOnboardingInput, options: RepositoryOnboardingOptions = {}): Promise<RepositoryInspection> {
    return this.inspect(input, options);
  }

  private async cloneUnsafe(input: RepositoryOnboardingInput, options: RepositoryOnboardingOptions): Promise<RepositoryCloneResult> {
    validateInput(input);
    const location = await pathInsideManagedRoot(input, false, true);
    assertNotAborted(options.signal, location.target);
    const state = await targetState(location.target);
    if (state === "symlink") fail("unsafe_path", "Repository target must not be a symlink", location.target);
    let emptyTargetIdentity: FileIdentity | undefined;
    if (state === "existing") {
      if (options.allowEmptyTarget !== true) {
        fail("target_exists", "Repository target already exists", location.target);
      }
      let entries: string[];
      try {
        entries = await readdir(location.target);
      } catch {
        fail("target_exists", "Repository target could not be inspected", location.target);
      }
      if (entries.length > 0) {
        fail("target_exists", "Repository target must be empty", location.target);
      }
      try {
        // Keep an initially empty target in place until the staged clone has
        // passed validation. This preserves the caller's directory when
        // cloning or validation fails; it is removed only immediately before
        // the no-replace install claim below.
        emptyTargetIdentity = fileIdentity(await lstat(location.target));
      } catch {
        fail("target_exists", "Repository target changed before clone", location.target);
      }
    }
    const expected = expectedIdentity(input);
    let stagingRoot: string | undefined;
    let askpassPath: string | undefined;
    let installationClaim: InstallationClaim | undefined;
    let removedEmptyTarget = false;
    let installSucceeded = false;
    try {
      stagingRoot = await mkdtemp(join(dirname(location.target), ".loongboard-repository-"));
      const stagingRepo = join(stagingRoot, "repository");
      const credential = input.credential === undefined ? undefined : await input.credential();
      assertNotAborted(options.signal, location.target);
      let env: NodeJS.ProcessEnv | undefined;
      if (credential !== undefined) {
        askpassPath = join(stagingRoot, "askpass.sh");
        await writeFile(askpassPath, ASKPASS_SCRIPT, { encoding: "utf8", mode: 0o700 });
        await chmod(askpassPath, 0o700);
        env = {
          GIT_ASKPASS: askpassPath,
          GIT_TERMINAL_PROMPT: "0",
          LOONGBOARD_ONBOARDING_USERNAME: credential.username ?? "x-access-token",
          LOONGBOARD_ONBOARDING_PASSWORD: credential.password ?? credential.token ?? "",
        };
      } else {
        env = { GIT_TERMINAL_PROMPT: "0" };
      }
      try {
        await this.runner.runText(dirname(stagingRepo), [
          "clone",
          "--filter=blob:none",
          "--single-branch",
          "--branch",
          input.defaultBranch,
          "--origin",
          input.remoteName,
          input.cloneUrl,
          stagingRepo,
        ], this.commandOptions(options, env));
      } catch (error) {
        mapCloneFailure(input, location.target, error, options.signal);
      }
      assertNotAborted(options.signal, location.target);
      const clonedRemote = (await this.runner.runText(stagingRepo, ["remote", "get-url", input.remoteName], this.commandOptions(options))).trim();
      if (!identityMatches(repositoryIdentity(clonedRemote), expected)) {
        fail("remote_mismatch", "Cloned repository remote does not match the requested repository", location.target);
      }
      await this.runner.runText(stagingRepo, ["show-ref", "--verify", "--quiet", `refs/remotes/${input.remoteName}/${input.defaultBranch}`], this.commandOptions(options));
      assertNotAborted(options.signal, location.target);
      if (options.validateStagedRepository !== undefined) {
        await options.validateStagedRepository(stagingRepo);
      }
      // Node's rename replaces an existing directory on some platforms. Claim
      // the destination with mkdir immediately after the final lstat instead;
      // this is the portable no-replace invariant. The staged repository is
      // then moved entry-by-entry into the directory we exclusively created.
      let finalState = await targetState(location.target);
      if (finalState === "existing" && emptyTargetIdentity !== undefined) {
        let currentTarget: FileIdentity;
        try {
          currentTarget = fileIdentity(await lstat(location.target));
          if (!sameObjectIdentity(currentTarget, emptyTargetIdentity)) {
            fail("target_exists", "Repository target changed during clone", location.target);
          }
          if ((await readdir(location.target)).length !== 0) {
            fail("target_exists", "Repository target changed during clone", location.target);
          }
          // Remove only the directory entry after the staged checkout has
          // been validated. This is not recursive and cannot delete content.
          await rmdir(location.target);
          removedEmptyTarget = true;
        } catch (error) {
          if (error instanceof RepositoryOnboardingError) throw error;
          fail("target_exists", "Repository target changed during clone", location.target);
        }
        finalState = await targetState(location.target);
      }
      if (finalState !== "missing") fail("target_exists", "Repository target appeared during clone", location.target);
      try {
        await mkdir(location.target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          fail("target_exists", "Repository target appeared during clone", location.target);
        }
        throw error;
      }
      const claimToken = randomUUID();
      const markerPath = join(location.target, `.loongboard-onboarding-${claimToken}.claim`);
      installationClaim = {
        targetPath: location.target,
        target: fileIdentity(await lstat(location.target)),
        markerPath,
        token: claimToken,
        movedEntries: new Map(),
      };
      await writeFile(markerPath, `${claimToken}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      installationClaim.marker = fileIdentity(await lstat(markerPath));
      const stagedEntries = await readdir(stagingRepo);
      for (const entry of stagedEntries) {
        assertNotAborted(options.signal, location.target);
        const destination = join(location.target, entry);
        if (await targetState(destination) !== "missing") {
          fail("target_exists", "Repository target changed during clone", location.target);
        }
        await this.renameEntry(join(stagingRepo, entry), destination);
        installationClaim.movedEntries.set(entry, fileIdentity(await lstat(destination)));
      }
      assertNotAborted(options.signal, location.target);
      const markerStat = await lstat(markerPath);
      if (!sameFileIdentity(fileIdentity(markerStat), installationClaim.marker)) {
        fail("target_exists", "Repository target claim changed during clone", location.target);
      }
      await rm(markerPath, { force: false });
      installationClaim = undefined;
      installSucceeded = true;
      return { action: "cloned", ...resultBase(input, location.target) };
    } catch (error) {
      if (options.signal?.aborted === true) {
        throw new RepositoryOnboardingError("canceled", "Repository onboarding was canceled", location.target);
      }
      if (error instanceof RepositoryOnboardingError) throw error;
      mapGitFailure("clone_failed", "repository clone", location.target, error);
      throw new RepositoryOnboardingError("clone_failed", "Git repository clone failed", location.target);
    } finally {
      await this.cleanupOwnedTarget(installationClaim);
      if (removedEmptyTarget && !installSucceeded) {
        await this.restoreEmptyTarget(location.target);
      }
      if (askpassPath !== undefined) await rm(askpassPath, { force: true }).catch(() => undefined);
      if (stagingRoot !== undefined) await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async clone(input: RepositoryOnboardingInput, options: RepositoryOnboardingOptions = {}): Promise<RepositoryCloneResult> {
    return this.serialized(resolve(input.targetPath), () => this.cloneUnsafe(input, options));
  }

  async ensure(input: RepositoryOnboardingInput, options: RepositoryOnboardingOptions = {}): Promise<RepositoryEnsureResult> {
    return this.serialized(resolve(input.targetPath), async () => {
      validateInput(input);
      const location = await pathInsideManagedRoot(input, false, true);
      const state = await targetState(location.target);
      if (state !== "missing") return this.inspectUnsafe(input, options);
      return this.cloneUnsafe(input, options);
    });
  }
}
