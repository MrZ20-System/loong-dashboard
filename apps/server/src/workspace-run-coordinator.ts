import { resolve } from "node:path";

/**
 * In-process serialization of agent turns per workspace path (plan P0:
 * "统一 workspace ownership"). Manual chats and scheduled runs share one
 * instance from the server runtime so a path can never be modified by two
 * agent turns at the same time. This is intentionally not a queue, database
 * lease, or distributed lock.
 */
export class WorkspaceRunCoordinator {
  private readonly active = new Set<string>();

  isBusy(path: string): boolean {
    return this.active.has(resolve(path));
  }

  /**
   * Claim the workspace. Returns an idempotent release function, or null
   * when another agent turn already owns the workspace.
   */
  acquire(path: string): (() => void) | null {
    const key = resolve(path);
    if (this.active.has(key)) return null;
    this.active.add(key);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active.delete(key);
    };
  }
}
