import {
  lstat,
  realpath,
  readdir,
  rm,
  rmdir,
} from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export interface AgentSessionHomeCleanup {
  readonly remove: () => Promise<void>;
}

const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Validate and prepare deletion of one exact per-session DSH home.
 *
 * The root is resolved once when this cleaner is constructed. The returned
 * operation re-checks lstat/realpath immediately before removal to fail closed
 * if a path component was replaced while the caller was stopping the runtime.
 */
export class AgentSessionHomeCleaner {
  private readonly root: string;

  constructor(agentSessionsPath: string) {
    this.root = resolve(agentSessionsPath);
  }

  async prepare(sessionId: string): Promise<AgentSessionHomeCleanup> {
    const target = this.targetFor(sessionId);
    try {
      await this.validatePath(sessionId, target);
    } catch (error) {
      throw new Error(
        `Cannot clean DSH home for agent session "${sessionId}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return {
      remove: async () => {
        await this.removeTarget(sessionId, target);
      },
    };
  }

  private targetFor(sessionId: string): { sessionDir: string; dshHome: string } {
    if (!SAFE_SESSION_ID.test(sessionId) || isAbsolute(sessionId)) {
      throw new Error(`Cannot clean DSH home for agent session "${sessionId}": unsafe session id`);
    }
    const sessionDir = resolve(this.root, sessionId);
    const dshHome = resolve(sessionDir, "dsh-home");
    const targetRelative = relative(this.root, dshHome);
    if (
      dshHome === this.root ||
      targetRelative === "" ||
      targetRelative.startsWith("..") ||
      isAbsolute(targetRelative)
    ) {
      throw new Error(`Cannot clean DSH home for agent session "${sessionId}": target is outside the agent sessions root`);
    }
    return { sessionDir, dshHome };
  }

  private async validatePath(
    sessionId: string,
    paths: { sessionDir: string; dshHome: string },
  ): Promise<void> {
    const rootStat = await this.lstatIfPresent(this.root);
    if (rootStat === null) return;
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error(`Cannot clean DSH home for agent session "${sessionId}": agent sessions root is not a directory`);
    }
    const rootReal = await realpath(this.root);
    const sessionStat = await this.lstatIfPresent(paths.sessionDir);
    if (sessionStat === null) return;
    if (!sessionStat.isDirectory() || sessionStat.isSymbolicLink()) {
      throw new Error(`Cannot clean DSH home for agent session "${sessionId}": session directory is not a real directory`);
    }
    const sessionReal = await realpath(paths.sessionDir);
    this.assertInsideRoot(sessionId, rootReal, sessionReal, "session directory");

    const dshStat = await this.lstatIfPresent(paths.dshHome);
    if (dshStat === null) return;
    if (!dshStat.isDirectory() || dshStat.isSymbolicLink()) {
      throw new Error(`Cannot clean DSH home for agent session "${sessionId}": dsh-home is not a real directory`);
    }
    const dshReal = await realpath(paths.dshHome);
    this.assertInsideRoot(sessionId, rootReal, dshReal, "dsh-home");
    const expectedReal = resolve(rootReal, relative(this.root, paths.dshHome));
    if (dshReal !== expectedReal) {
      throw new Error(`Cannot clean DSH home for agent session "${sessionId}": dsh-home resolves outside its expected path`);
    }
  }

  private async removeTarget(
    sessionId: string,
    paths: { sessionDir: string; dshHome: string },
  ): Promise<void> {
    try {
      await this.validatePath(sessionId, paths);
      const dshStat = await this.lstatIfPresent(paths.dshHome);
      if (dshStat !== null) {
        await rm(paths.dshHome, { recursive: true, force: false });
      }
      const sessionStat = await this.lstatIfPresent(paths.sessionDir);
      if (sessionStat !== null) {
        if (!sessionStat.isDirectory() || sessionStat.isSymbolicLink()) {
          throw new Error("session directory changed into a non-directory or symlink");
        }
        if ((await readdir(paths.sessionDir)).length === 0) {
          await rmdir(paths.sessionDir);
        }
      }
    } catch (error) {
      throw new Error(
        `Failed to clean DSH home for agent session "${sessionId}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async lstatIfPresent(path: string) {
    try {
      return await lstat(path);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  private assertInsideRoot(
    sessionId: string,
    rootReal: string,
    candidateReal: string,
    label: string,
  ): void {
    const candidateRelative = relative(rootReal, candidateReal);
    if (
      candidateReal === rootReal ||
      candidateRelative === "" ||
      candidateRelative.startsWith("..") ||
      isAbsolute(candidateRelative)
    ) {
      throw new Error(`Cannot clean DSH home for agent session "${sessionId}": ${label} escapes the agent sessions root`);
    }
  }
}

function isMissing(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
