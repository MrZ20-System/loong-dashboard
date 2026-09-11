import { basename, dirname, resolve, join } from "node:path";
import { realpathSync } from "node:fs";

function canonicalRepositoryPath(repositoryPath: string): string {
  let candidate = resolve(repositoryPath);
  const suffix: string[] = [];
  while (true) {
    try {
      const canonical = realpathSync(candidate);
      return suffix.reduceRight((path, segment) => join(path, segment), canonical);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      suffix.push(basename(candidate));
      candidate = parent;
    }
  }
}

/**
 * Serializes Git index/ref operations per repository without claiming the
 * Agent workspace lock. Different repositories retain independent concurrency.
 */
export class GitRepositoryLock {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(repositoryPath: string, operation: () => Promise<T>): Promise<T> {
    const key = canonicalRepositoryPath(repositoryPath);
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const tail = previous.then(() => gate);
    this.tails.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
