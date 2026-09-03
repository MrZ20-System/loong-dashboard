import {
  listDomainRules,
  listPullRequestFileSets,
  replacePullRequestDomains,
  type DatabaseClient,
} from "@loongboard/database";

import {
  classifyFileSet,
  computeClassificationKey,
  computeFileSetHash,
  computeRuleSetHash,
} from "./domain-classifier.js";

/** PRs processed per event-loop turn during background reclassification. */
const RECLASSIFICATION_BATCH_SIZE = 200;

export interface ReclassificationSnapshot {
  running: boolean;
  pendingCount: number | null;
}

/** The narrow dependency consumed by the HTTP application factory. */
export interface DomainReclassification {
  trigger(repositoryId: string): ReclassificationSnapshot;
  status(repositoryId: string): ReclassificationSnapshot;
  close(): Promise<void>;
}

export interface DomainReclassificationLogger {
  error(...arguments_: readonly unknown[]): void;
}

export interface DomainReclassificationServiceOptions {
  database: DatabaseClient;
  logger?: DomainReclassificationLogger;
  batchSize?: number;
}

interface RepositoryRunState {
  running: boolean;
  dirty: boolean;
  pendingCount: number | null;
}

/**
 * One serial in-process background reclassification task per repository
 * (plan 10.3). Rule mutations only flip local rows — this service never
 * calls GitHub. A mutation arriving mid-run schedules exactly one follow-up
 * run via a dirty flag, so bursts of edits collapse into one recompute.
 */
export class DomainReclassificationService implements DomainReclassification {
  private readonly database: DatabaseClient;
  private readonly logger: DomainReclassificationLogger;
  private readonly batchSize: number;
  private readonly states = new Map<string, RepositoryRunState>();
  private readonly pending = new Set<Promise<void>>();
  private closed = false;

  constructor(options: DomainReclassificationServiceOptions) {
    if (
      options.batchSize !== undefined &&
      (!Number.isInteger(options.batchSize) || options.batchSize <= 0)
    ) {
      throw new Error("batchSize must be a positive integer");
    }
    this.database = options.database;
    this.logger = options.logger ?? console;
    this.batchSize = options.batchSize ?? RECLASSIFICATION_BATCH_SIZE;
  }

  /** Mark the repository for (re)classification; returns the live snapshot. */
  trigger(repositoryId: string): ReclassificationSnapshot {
    const state = this.stateFor(repositoryId);
    if (state.running) {
      state.dirty = true;
      return this.snapshot(state);
    }
    if (this.closed) {
      return this.snapshot(state);
    }
    this.startRun(repositoryId, state);
    return this.snapshot(state);
  }

  status(repositoryId: string): ReclassificationSnapshot {
    return this.snapshot(this.stateFor(repositoryId));
  }

  async close(): Promise<void> {
    this.closed = true;
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }

  private stateFor(repositoryId: string): RepositoryRunState {
    let state = this.states.get(repositoryId);
    if (state === undefined) {
      state = { running: false, dirty: false, pendingCount: null };
      this.states.set(repositoryId, state);
    }
    return state;
  }

  private snapshot(state: RepositoryRunState): ReclassificationSnapshot {
    return { running: state.running, pendingCount: state.pendingCount };
  }

  private startRun(repositoryId: string, state: RepositoryRunState): void {
    state.running = true;
    state.pendingCount = null;
    const task = this.run(repositoryId, state)
      .catch((error: unknown) => {
        this.logger.error("Domain reclassification failed", error, {
          repositoryId,
        });
      })
      .finally(() => {
        state.running = false;
        state.pendingCount = null;
        if (state.dirty && !this.closed) {
          state.dirty = false;
          this.startRun(repositoryId, state);
        }
      });
    this.pending.add(task);
    task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );
  }

  private async run(
    repositoryId: string,
    state: RepositoryRunState,
  ): Promise<void> {
    const rules = listDomainRules(this.database, repositoryId);
    const ruleSetHash = computeRuleSetHash(rules);
    const fileSets = listPullRequestFileSets(this.database, repositoryId);
    state.pendingCount = fileSets.length;

    for (let offset = 0; offset < fileSets.length; offset += this.batchSize) {
      const slice = fileSets.slice(offset, offset + this.batchSize);
      for (const fileSet of slice) {
        const key = computeClassificationKey(
          ruleSetHash,
          computeFileSetHash(fileSet.paths),
        );
        const domainRuleIds = classifyFileSet(fileSet.paths, rules);
        replacePullRequestDomains(
          this.database,
          repositoryId,
          fileSet.prNumber,
          domainRuleIds,
          key,
        );
      }
      state.pendingCount = fileSets.length - (offset + slice.length);
      // Yield between batches so HTTP requests stay responsive.
      if (offset + this.batchSize < fileSets.length) {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      }
    }
  }
}
