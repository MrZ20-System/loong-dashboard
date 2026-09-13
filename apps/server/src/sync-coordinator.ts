import {
  createSyncRun,
  beginQueuedForwardSync,
  getRepository,
  getRepositoryHistoryState,
  getRepositorySyncState,
  getRepositorySyncStatus,
  getSyncRun,
  listRepositories,
  interruptSyncRun,
  markSyncRunStarted,
  SyncAlreadyRunningError,
  updateRepositoryHistoryState,
  type DatabaseClient,
  type PullRequestEnrichmentTarget,
  type RepositoryHistoryState,
  type RepositoryRecord,
  type RepositorySyncState,
  type SyncRun,
  type SyncRunRecord,
  type SyncRunTrigger,
} from "@loongboard/database";
import type {
  GitHubMetadataProvider,
  GitHubRateLimit,
} from "@loongboard/github";

import type { PullRequestFileEnricher } from "./enrichment-service.js";
import {
  ForwardSyncRunner,
  type ForwardSyncJob,
} from "./forward-sync-runner.js";
import {
  HistorySyncRunner,
  type HistorySyncJob,
} from "./history-sync-runner.js";
import {
  FetchPullRequestRunner,
  type FetchPullRequestJob,
} from "./fetch-pr-runner.js";

const DEFAULT_MAX_CONCURRENT_REPOSITORIES = 2;
const DEFAULT_CALENDAR_TIME_ZONE = "UTC";
const DEFAULT_HISTORY_PAGE_BUDGET = 20;
/**
 * Keep the next bounded history batch asynchronous.  A small delay prevents
 * a provider that returns very small pages from turning continuation into a
 * tight loop, while still making an enabled history setting self-progressing.
 */
const HISTORY_CONTINUATION_DELAY_MS = 250;

export interface SyncCoordinatorLogger {
  error(...arguments_: readonly unknown[]): void;
}

export interface HistoryStartOptions {
  targetDate?: string | null;
  trigger?: SyncRunTrigger;
}

export interface FetchPullRequestStartOptions {
  trigger?: SyncRunTrigger;
}

export interface HistorySettingsUpdate {
  enabled?: boolean;
  targetDate?: string | null;
}

export class HistoryPausedError extends Error {
  readonly code = "HISTORY_PAUSED" as const;

  constructor(repositoryId: string) {
    super(`History sync is paused for repository ${repositoryId}`);
    this.name = "HistoryPausedError";
  }
}

export interface RepositorySyncCoordinatorOptions {
  database: DatabaseClient;
  provider: GitHubMetadataProvider;
  maxConcurrentRepositories?: number;
  lookbackDays?: number;
  lookbackDaysForRepository?: (repositoryId: string) => number;
  calendarTimeZone?: string;
  /** Maximum provider pages admitted by one history run. */
  historyPageBudget?: number;
  /** Startup gate for configured repositories awaiting checkout onboarding. */
  repositoryAvailability?: (repository: RepositoryRecord) => boolean;
  now?: () => Date;
  logger?: SyncCoordinatorLogger;
  enricher?: PullRequestFileEnricher;
}

export interface SyncCoordinator {
  start(repositoryId: string, trigger?: SyncRunTrigger): SyncRun;
  startHistory(repositoryId: string, options?: HistoryStartOptions): SyncRun;
  startFetchPullRequest(
    repositoryId: string,
    number: number,
    options?: FetchPullRequestStartOptions,
  ): SyncRun;
  configureHistory(repositoryId: string, update: HistorySettingsUpdate): void;
  pauseHistory(repositoryId: string): void;
  resumeHistory(repositoryId: string, options?: HistoryStartOptions): SyncRun;
  /** Re-admit enabled history whose last process died mid-cursor. */
  resumeEnabledHistories?(): void;
  /** True when this repository has queued or admitted sync work. */
  isRepositorySyncActive?(repositoryId: string): boolean;
  /** External metadata maintenance shares the repository admission pump. */
  setRepositoryMaintenanceActive?(repositoryId: string, active: boolean): void;
  waitForRun?(runId: string): Promise<SyncRunRecord>;
  waitForIdle(): Promise<void>;
  close(): Promise<void>;
}

type RepositorySyncJob = ForwardSyncJob | HistorySyncJob | FetchPullRequestJob;
type ForegroundJob = ForwardSyncJob | FetchPullRequestJob;

class RepositoryConcurrencyLimiter {
  private active = 0;
  private activeHistory = 0;
  private readonly waiters: Array<{
    kind: "foreground" | "history";
    resolve: () => void;
  }> = [];

  constructor(private readonly maximum: number) {}

  get activeCount(): number {
    return this.active;
  }

  get maximumCount(): number {
    return this.maximum;
  }

  async run<T>(task: () => Promise<T>, kind: "foreground" | "history"): Promise<T> {
    await this.acquire(kind);
    try {
      return await task();
    } finally {
      this.release(kind);
    }
  }

  private acquire(kind: "foreground" | "history"): Promise<void> {
    if (this.canAcquire(kind)) {
      this.markAcquired(kind);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push({ kind, resolve });
    });
  }

  private release(kind: "foreground" | "history"): void {
    this.active -= 1;
    if (kind === "history") this.activeHistory -= 1;
    const index = this.waiters.findIndex(
      (waiter) => waiter.kind === "foreground" && this.canAcquire(waiter.kind),
    ) !== -1
      ? this.waiters.findIndex(
          (waiter) => waiter.kind === "foreground" && this.canAcquire(waiter.kind),
        )
      : this.waiters.findIndex((waiter) => this.canAcquire(waiter.kind));
    if (index === -1) return;
    const [waiter] = this.waiters.splice(index, 1);
    this.markAcquired(waiter!.kind);
    waiter!.resolve();
  }

  private canAcquire(kind: "foreground" | "history"): boolean {
    if (this.active >= this.maximum) return false;
    if (kind === "foreground") return true;
    // Keep one repository slot available for a forward sync or explicit PR
    // fetch whenever the configured capacity allows it.  A single-slot
    // coordinator still needs to make progress on history by using that slot.
    const historyCapacity = this.maximum > 1 ? this.maximum - 1 : 1;
    return this.activeHistory < historyCapacity;
  }

  private markAcquired(kind: "foreground" | "history"): void {
    this.active += 1;
    if (kind === "history") this.activeHistory += 1;
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

/** Durable coordinator for forward, history, and single-PR fetch runs. */
export class RepositorySyncCoordinator implements SyncCoordinator {
  private readonly database: DatabaseClient;
  private readonly provider: GitHubMetadataProvider;
  private readonly limiter: RepositoryConcurrencyLimiter;
  private readonly lookbackDays: number | undefined;
  private readonly lookbackDaysForRepository:
    | ((repositoryId: string) => number)
    | undefined;
  private readonly calendarTimeZone: string;
  private readonly historyPageBudget: number;
  private readonly repositoryAvailability: ((repository: RepositoryRecord) => boolean) | undefined;
  private readonly now: () => Date;
  private readonly logger: SyncCoordinatorLogger;
  private readonly enricher: PullRequestFileEnricher | undefined;
  private readonly forwardRunner: ForwardSyncRunner;
  private readonly historyRunner: HistorySyncRunner;
  private readonly fetchPullRequestRunner: FetchPullRequestRunner;
  private readonly pending = new Set<Promise<void>>();
  private readonly activeRepositories = new Set<string>();
  /** One admitted or globally-waiting job per repository. */
  private readonly scheduledJobs = new Map<string, RepositorySyncJob>();
  /** Foreground work is durable but remains outside repository running state until admitted. */
  private readonly foregroundQueues = new Map<string, ForegroundJob[]>();
  /** At most one continuation may wait behind the foreground FIFO. */
  private readonly pendingHistoryJobs = new Map<string, HistorySyncJob>();
  private readonly activeMetadataMaintenance = new Set<string>();
  private readonly historyContinuationTimers = new Map<string, {
    timer: ReturnType<typeof setTimeout>;
    cancel: () => void;
  }>();
  private readonly completions = new Map<string, Deferred<SyncRunRecord>>();
  private closed = false;

  constructor(options: RepositorySyncCoordinatorOptions) {
    const maximum = options.maxConcurrentRepositories ?? DEFAULT_MAX_CONCURRENT_REPOSITORIES;
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 4) {
      throw new Error("maxConcurrentRepositories must be an integer between 1 and 4");
    }
    if (
      options.lookbackDays !== undefined &&
      (!Number.isInteger(options.lookbackDays) || options.lookbackDays <= 0)
    ) {
      throw new Error("lookbackDays must be a positive integer");
    }
    this.database = options.database;
    this.provider = options.provider;
    this.limiter = new RepositoryConcurrencyLimiter(maximum);
    this.lookbackDays = options.lookbackDays;
    this.lookbackDaysForRepository = options.lookbackDaysForRepository;
    this.calendarTimeZone = options.calendarTimeZone ?? DEFAULT_CALENDAR_TIME_ZONE;
    this.historyPageBudget = options.historyPageBudget ?? DEFAULT_HISTORY_PAGE_BUDGET;
    this.repositoryAvailability = options.repositoryAvailability;
    if (
      !Number.isInteger(this.historyPageBudget) ||
      this.historyPageBudget < 1 ||
      this.historyPageBudget > 100
    ) {
      throw new Error("historyPageBudget must be an integer between 1 and 100");
    }
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? console;
    this.enricher = options.enricher;
    const enrichPullRequestFiles = (
      repository: RepositoryRecord,
      rateLimit: GitHubRateLimit | undefined,
      targets: readonly PullRequestEnrichmentTarget[],
    ): Promise<void> => this.enrichPullRequestFiles(repository, rateLimit, targets);
    this.forwardRunner = new ForwardSyncRunner({
      database: this.database,
      provider: this.provider,
      logger: this.logger,
      timestamp: () => this.timestamp(),
      enrichPullRequestFiles,
    });
    this.historyRunner = new HistorySyncRunner({
      database: this.database,
      provider: this.provider,
      logger: this.logger,
      timestamp: () => this.timestamp(),
      calendarDay: (value) => this.calendarDay(value),
    });
    this.fetchPullRequestRunner = new FetchPullRequestRunner({
      database: this.database,
      provider: this.provider,
      logger: this.logger,
      timestamp: () => this.timestamp(),
      enrichPullRequestFiles,
    });
  }

  get activeRepositoryCount(): number {
    return this.limiter.activeCount;
  }

  get maxConcurrentRepositories(): number {
    return this.limiter.maximumCount;
  }

  isRepositorySyncActive(repositoryId: string): boolean {
    this.requireRepository(repositoryId);
    const status = getRepositorySyncStatus(this.database, repositoryId);
    return this.hasLocalWork(repositoryId) ||
      status.pullRequests.status === "running" ||
      status.issues.status === "running";
  }

  setRepositoryMaintenanceActive(repositoryId: string, active: boolean): void {
    this.requireRepository(repositoryId);
    if (active) {
      this.activeMetadataMaintenance.add(repositoryId);
    } else {
      this.activeMetadataMaintenance.delete(repositoryId);
      this.pumpRepository(repositoryId);
    }
  }

  start(repositoryId: string, trigger: SyncRunTrigger = "manual"): SyncRun {
    if (this.closed) throw new Error("Cannot start a sync after coordinator close");
    const repository = this.requireRepository(repositoryId);
    this.assertForegroundAvailable(repositoryId);
    if (this.hasForegroundJob(repositoryId, (job) => job.kind === "forward")) {
      throw new SyncAlreadyRunningError(repositoryId);
    }
    const pullRequestState = getRepositorySyncState(this.database, repositoryId, "pull_request");
    const issueState = getRepositorySyncState(this.database, repositoryId, "issue");
    const run = createSyncRun(this.database, {
      repositoryId,
      kind: "forward",
      trigger,
      attemptStartedAt: this.timestamp(),
      watermarkBefore: {
        pull_request: pullRequestState.watermarkUpdatedAt,
        issue: issueState.watermarkUpdatedAt,
      },
      entityKinds: ["pull_request", "issue"],
    });
    this.enqueueForeground({
      run,
      repository,
      kind: "forward",
      pullRequestState,
      issueState,
      lookbackDays: this.resolveLookbackDays(repositoryId),
      targetNumbers: new Map(),
    });
    return this.attachCompletion(run);
  }

  startHistory(repositoryId: string, options: HistoryStartOptions = {}): SyncRun {
    return this.startHistoryBatch(repositoryId, options, false);
  }

  /**
   * Start one bounded history batch.  A continuation is deliberately a new
   * durable run: callers waiting on the original run still receive that run's
   * completion, while the persisted cursor/state tells the next batch where
   * to resume.
   */
  private startHistoryBatch(
    repositoryId: string,
    options: HistoryStartOptions,
    continuation: boolean,
    recoverInterrupted = false,
  ): SyncRun {
    if (this.closed) throw new Error("Cannot start a sync after coordinator close");
    const repository = this.requireRepository(repositoryId);
    if (!continuation) this.assertHistoryAvailable(repositoryId);
    const pullRequestState = getRepositoryHistoryState(this.database, repositoryId, "pull_request");
    const issueState = getRepositoryHistoryState(this.database, repositoryId, "issue");
    if (
      pullRequestState.status === "paused" ||
      issueState.status === "paused" ||
      (continuation && (!pullRequestState.enabled && !issueState.enabled))
    ) {
      throw new HistoryPausedError(repositoryId);
    }
    const targetDate = options.targetDate === undefined
      ? pullRequestState.targetDate ?? issueState.targetDate
      : options.targetDate;
    const pullRequestNeedsWork =
      !continuation ||
      pullRequestState.status === "running" ||
      (recoverInterrupted && this.canResumePersistedHistory(pullRequestState));
    const issueNeedsWork =
      !continuation ||
      issueState.status === "running" ||
      (recoverInterrupted && this.canResumePersistedHistory(issueState));
    const run = createSyncRun(this.database, {
      repositoryId,
      kind: "history",
      trigger: options.trigger ?? "manual",
      selector: { targetDate },
      entityKinds: ["pull_request", "issue"],
    });
    if (pullRequestNeedsWork) {
      updateRepositoryHistoryState(this.database, repositoryId, "pull_request", {
        enabled: true,
        status: "running",
        targetDate,
        lastRunId: run.syncRunId,
        lastError: null,
        resumeAfter: null,
      });
    }
    if (issueNeedsWork) {
      updateRepositoryHistoryState(this.database, repositoryId, "issue", {
        enabled: true,
        status: "running",
        targetDate,
        lastRunId: run.syncRunId,
        lastError: null,
        resumeAfter: null,
      });
    }
    const job: HistorySyncJob = {
      run,
      repository,
      kind: "history",
      targetDate,
      pullRequestState,
      issueState,
      pullRequestOldestObserved: { value: pullRequestState.oldestCoveredDay },
      issueOldestObserved: { value: issueState.oldestCoveredDay },
      pageBudget: this.historyPageBudget,
      pullRequestNeedsWork,
      issueNeedsWork,
    };
    if (
      continuation &&
      (this.hasLocalWork(repositoryId) || this.activeMetadataMaintenance.has(repositoryId))
    ) {
      this.pendingHistoryJobs.set(repositoryId, job);
    } else {
      this.schedule(job);
    }
    return this.attachCompletion(run);
  }

  configureHistory(repositoryId: string, update: HistorySettingsUpdate): void {
    if (update.enabled === undefined && update.targetDate === undefined) {
      throw new Error("History settings update must include enabled or targetDate");
    }
    this.requireRepository(repositoryId);
    for (const entityKind of ["pull_request", "issue"] as const) {
      const state = getRepositoryHistoryState(this.database, repositoryId, entityKind);
      const enabled = update.enabled ?? state.enabled;
      const targetDate = update.targetDate === undefined ? state.targetDate : update.targetDate;
      const targetChanged = update.targetDate !== undefined && update.targetDate !== state.targetDate;
      updateRepositoryHistoryState(this.database, repositoryId, entityKind, {
        enabled,
        status: enabled
          ? state.status === "paused" || targetChanged ? "idle" : state.status
          : "paused",
        targetDate,
        lastError: enabled ? null : state.lastError,
        resumeAfter: enabled ? targetChanged ? null : state.resumeAfter : null,
      });
    }
  }

  pauseHistory(repositoryId: string): void {
    this.configureHistory(repositoryId, { enabled: false });
  }

  resumeHistory(repositoryId: string, options: HistoryStartOptions = {}): SyncRun {
    this.configureHistory(repositoryId, { enabled: true });
    return this.startHistory(repositoryId, options);
  }

  /**
   * Admit a fresh continuation run for unfinished persisted history. This
   * covers both process interruption and a bounded partial run written by an
   * older release before automatic continuation existed. The prior run stays
   * immutable; only its persisted cursor and recovery anchor are reused.
   */
  resumeEnabledHistories(): void {
    if (this.closed) return;
    for (const repository of listRepositories(this.database)) {
      if (this.repositoryAvailability !== undefined && !this.repositoryAvailability(repository)) {
        continue;
      }
      const pullRequestState = getRepositoryHistoryState(
        this.database,
        repository.id,
        "pull_request",
      );
      const issueState = getRepositoryHistoryState(this.database, repository.id, "issue");
      this.clearExpiredHistoryResumeAfter(repository.id);
      if (this.historyResumeAfter(repository.id) !== null) {
        this.scheduleHistoryContinuation(repository.id);
        continue;
      }
      const resumable = [pullRequestState, issueState].some(
        (state) => this.canResumePersistedHistory(state),
      );
      if (!resumable) continue;
      if (this.hasLocalWork(repository.id)) {
        this.scheduleHistoryContinuation(repository.id);
        continue;
      }
      try {
        this.startHistoryBatch(
          repository.id,
          {
            targetDate: pullRequestState.targetDate ?? issueState.targetDate,
            trigger: "system",
          },
          true,
          true,
        );
      } catch (error: unknown) {
        this.logError("Unable to resume persisted repository history", error, {
          repositoryId: repository.id,
        });
      }
    }
  }

  startFetchPullRequest(
    repositoryId: string,
    number: number,
    options: FetchPullRequestStartOptions = {},
  ): SyncRun {
    if (!Number.isInteger(number) || number <= 0) {
      throw new Error("Pull request number must be a positive integer");
    }
    if (this.closed) throw new Error("Cannot start a sync after coordinator close");
    const repository = this.requireRepository(repositoryId);
    this.assertForegroundAvailable(repositoryId);
    if (this.hasForegroundJob(repositoryId, (job) =>
      job.kind === "fetch_pr" && job.number === number,
    )) {
      throw new SyncAlreadyRunningError(repositoryId);
    }
    const run = createSyncRun(this.database, {
      repositoryId,
      kind: "fetch_pr",
      trigger: options.trigger ?? "manual",
      selector: { number },
      entityKinds: ["pull_request"],
    });
    this.enqueueForeground({
      run,
      repository,
      kind: "fetch_pr",
      number,
      targetNumbers: new Map(),
    });
    return this.attachCompletion(run);
  }

  async waitForRun(runId: string): Promise<SyncRunRecord> {
    const completion = this.completions.get(runId);
    if (completion !== undefined) return completion.promise;
    const record = getSyncRun(this.database, runId);
    if (record.status === "queued" || record.status === "running") {
      const pending = deferred<SyncRunRecord>();
      this.completions.set(runId, pending);
      return pending.promise;
    }
    return record;
  }

  async waitForIdle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const continuation of [...this.historyContinuationTimers.values()]) continuation.cancel();
    for (const queue of this.foregroundQueues.values()) {
      for (const job of queue) this.interruptQueuedJob(job);
    }
    this.foregroundQueues.clear();
    for (const job of this.pendingHistoryJobs.values()) this.interruptQueuedJob(job);
    this.pendingHistoryJobs.clear();
    await this.waitForIdle();
  }

  private attachCompletion(run: SyncRun): SyncRun {
    const pending = deferred<SyncRunRecord>();
    this.completions.set(run.syncRunId, pending);
    Object.defineProperty(run, "completion", {
      configurable: false,
      enumerable: false,
      value: pending.promise,
    });
    return run;
  }

  private enqueueForeground(job: ForegroundJob): void {
    const queue = this.foregroundQueues.get(job.repository.id) ?? [];
    queue.push(job);
    this.foregroundQueues.set(job.repository.id, queue);
    // Foreground work should never wait for a history delay.  The durable
    // cursor remains in place and the unified pump will re-arm it afterwards.
    this.cancelHistoryContinuation(job.repository.id);
    this.pumpRepository(job.repository.id);
  }

  private hasForegroundJob(
    repositoryId: string,
    predicate: (job: ForegroundJob) => boolean,
  ): boolean {
    const scheduled = this.scheduledJobs.get(repositoryId);
    if (scheduled !== undefined && scheduled.kind !== "history" && predicate(scheduled)) {
      return true;
    }
    return this.foregroundQueues.get(repositoryId)?.some(predicate) ?? false;
  }

  private hasLocalWork(repositoryId: string): boolean {
    return this.activeRepositories.has(repositoryId) ||
      (this.foregroundQueues.get(repositoryId)?.length ?? 0) > 0 ||
      this.pendingHistoryJobs.has(repositoryId);
  }

  /** Admit the repository's next foreground job, then its history continuation. */
  private pumpRepository(repositoryId: string, timerFired = false): void {
    if (this.closed || this.scheduledJobs.has(repositoryId)) return;
    if (this.activeMetadataMaintenance.has(repositoryId)) return;

    const foreground = this.foregroundQueues.get(repositoryId);
    if (foreground !== undefined && foreground.length > 0) {
      const job = foreground.shift()!;
      if (foreground.length === 0) this.foregroundQueues.delete(repositoryId);
      this.schedule(job);
      return;
    }

    const history = this.pendingHistoryJobs.get(repositoryId);
    if (history !== undefined) {
      this.pendingHistoryJobs.delete(repositoryId);
      this.schedule(history);
      return;
    }

    if (timerFired) {
      this.clearExpiredHistoryResumeAfter(repositoryId);
      if (this.historyResumeAfter(repositoryId) !== null) {
        this.scheduleHistoryContinuation(repositoryId);
        return;
      }
      if (!this.hasHistoryContinuationIntent(repositoryId)) return;
      const pullRequestState = getRepositoryHistoryState(
        this.database,
        repositoryId,
        "pull_request",
      );
      const issueState = getRepositoryHistoryState(this.database, repositoryId, "issue");
      try {
        this.startHistoryBatch(
          repositoryId,
          {
            targetDate: pullRequestState.targetDate ?? issueState.targetDate,
            trigger: "system",
          },
          true,
          true,
        );
      } catch (error: unknown) {
        this.logError("Unable to continue repository history", error, { repositoryId });
      }
      return;
    }

    this.scheduleHistoryContinuation(repositoryId);
  }

  private schedule(job: RepositorySyncJob): void {
    if (this.closed) {
      this.interruptQueuedJob(job);
      return;
    }
    this.scheduledJobs.set(job.repository.id, job);
    this.activeRepositories.add(job.repository.id);
    const task = this.limiter
      .run(async () => {
        const startedAt = this.timestamp();
        // The public SyncRun is allocated when the request is queued, but all
        // provider windows must be anchored to actual repository admission.
        job.run.startedAt = startedAt;
        if (job.kind === "forward") {
          beginQueuedForwardSync(this.database, {
            repositoryId: job.repository.id,
            runId: job.run.syncRunId,
            startedAt,
          });
        } else {
          markSyncRunStarted(this.database, job.run.syncRunId, startedAt);
        }
        await this.execute(job);
      }, job.kind === "history" ? "history" : "foreground")
      .catch((error: unknown) => this.recordUnexpectedFailure(job, error))
      .finally(() => {
        this.scheduledJobs.delete(job.repository.id);
        this.activeRepositories.delete(job.repository.id);
        this.resolveCompletion(job.run.syncRunId);
        this.pumpRepository(job.repository.id);
      });
    this.pending.add(task);
    task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );
  }

  /**
   * Queue exactly one follow-up batch per repository.  History is persisted as
   * bounded runs so the run accepted by an HTTP caller remains bounded, but an
   * enabled stream with a durable cursor keeps making progress without asking
   * the UI to manufacture another request.
   */
  private scheduleHistoryContinuation(repositoryId: string): void {
    if (this.closed || this.historyContinuationTimers.has(repositoryId)) return;
    if (this.scheduledJobs.has(repositoryId)) return;
    if ((this.foregroundQueues.get(repositoryId)?.length ?? 0) > 0) return;
    if (this.pendingHistoryJobs.has(repositoryId)) return;
    this.clearExpiredHistoryResumeAfter(repositoryId);
    if (!this.hasHistoryContinuationIntent(repositoryId)) return;

    const resumeAfter = this.historyResumeAfter(repositoryId);
    const delay = resumeAfter === null
      ? HISTORY_CONTINUATION_DELAY_MS
      : Math.max(0, Date.parse(resumeAfter) - this.now().getTime());
    const waitForIdle = resumeAfter === null;
    let resolveTimer: (() => void) | undefined;
    let settled = false;
    const waitForTimer = waitForIdle
      ? new Promise<void>((resolve) => {
          resolveTimer = resolve;
        })
      : undefined;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      resolveTimer?.();
    };
    const timer = setTimeout(() => {
      this.historyContinuationTimers.delete(repositoryId);
      settle();
      if (!this.closed) this.pumpRepository(repositoryId, true);
    }, Math.min(delay, 2_147_483_647));
    const cancel = (): void => {
      clearTimeout(timer);
      this.historyContinuationTimers.delete(repositoryId);
      settle();
    };
    this.historyContinuationTimers.set(repositoryId, { timer, cancel });
    if (waitForTimer !== undefined) {
      this.pending.add(waitForTimer);
      waitForTimer.then(
        () => this.pending.delete(waitForTimer),
        () => this.pending.delete(waitForTimer),
      );
    }
  }

  private cancelHistoryContinuation(repositoryId: string): void {
    this.historyContinuationTimers.get(repositoryId)?.cancel();
  }

  private interruptQueuedJob(job: RepositorySyncJob): void {
    try {
      interruptSyncRun(this.database, job.run.syncRunId, this.timestamp());
    } catch (error: unknown) {
      this.logError("Unable to interrupt queued sync run", error, {
        repositoryId: job.repository.id,
        runId: job.run.syncRunId,
      });
    }
    this.resolveCompletion(job.run.syncRunId);
  }

  private async execute(job: RepositorySyncJob): Promise<void> {
    if (job.kind === "forward") {
      await this.forwardRunner.run(job);
    } else if (job.kind === "history") {
      await this.historyRunner.run(job);
    } else {
      await this.fetchPullRequestRunner.run(job);
    }
  }

  private async enrichPullRequestFiles(
    repository: RepositoryRecord,
    rateLimit: GitHubRateLimit | undefined,
    targets: readonly PullRequestEnrichmentTarget[],
  ): Promise<void> {
    if (this.enricher === undefined || targets.length === 0) return;
    try {
      await this.enricher.enrich(repository, rateLimit, targets);
    } catch (error: unknown) {
      this.logError("Pull request file enrichment failed", error, {
        repositoryId: repository.id,
      });
    }
  }

  private hasHistoryContinuationIntent(repositoryId: string): boolean {
    return [
      getRepositoryHistoryState(this.database, repositoryId, "pull_request"),
      getRepositoryHistoryState(this.database, repositoryId, "issue"),
    ].some((state) => this.historyStateHasContinuationIntent(state));
  }

  private historyStateHasContinuationIntent(state: RepositoryHistoryState): boolean {
    if (!state.enabled || state.cursor === null) return false;
    if (state.status === "paused" || state.status === "completed") return false;
    if (
      state.targetDate !== null &&
      state.oldestCoveredDay !== null &&
      state.oldestCoveredDay <= state.targetDate
    ) {
      return false;
    }
    return state.status === "running" || this.canResumePersistedHistory(state);
  }

  private historyResumeAfter(repositoryId: string): string | null {
    const now = this.now().getTime();
    let latest: string | null = null;
    for (const state of [
      getRepositoryHistoryState(this.database, repositoryId, "pull_request"),
      getRepositoryHistoryState(this.database, repositoryId, "issue"),
    ]) {
      if (!this.historyStateHasContinuationIntent(state) || state.resumeAfter === null) continue;
      const timestamp = Date.parse(state.resumeAfter);
      if (!Number.isFinite(timestamp) || timestamp <= now) continue;
      if (latest === null || Date.parse(latest) < timestamp) latest = state.resumeAfter;
    }
    return latest;
  }

  private clearExpiredHistoryResumeAfter(repositoryId: string): void {
    const now = this.now().getTime();
    for (const entityKind of ["pull_request", "issue"] as const) {
      const state = getRepositoryHistoryState(this.database, repositoryId, entityKind);
      if (state.resumeAfter === null) continue;
      const timestamp = Date.parse(state.resumeAfter);
      if (!state.enabled || state.status === "paused" || !Number.isFinite(timestamp) || timestamp <= now) {
        updateRepositoryHistoryState(this.database, repositoryId, entityKind, {
          resumeAfter: null,
        });
      }
    }
  }

  private canResumePersistedHistory(state: RepositoryHistoryState): boolean {
    if (!state.enabled || state.cursor === null || state.lastRunId === null) return false;
    try {
      const runStatus = getSyncRun(this.database, state.lastRunId).status;
      return runStatus === "interrupted" || runStatus === "partial";
    } catch {
      return false;
    }
  }

  private assertForegroundAvailable(repositoryId: string): void {
    const status = getRepositorySyncStatus(this.database, repositoryId);
    if (
      (status.pullRequests.status === "running" || status.issues.status === "running") &&
      !this.hasForegroundJob(repositoryId, () => true)
    ) {
      throw new SyncAlreadyRunningError(repositoryId);
    }
  }

  private assertHistoryAvailable(repositoryId: string): void {
    if (this.hasLocalWork(repositoryId)) throw new SyncAlreadyRunningError(repositoryId);
    if (this.activeMetadataMaintenance.has(repositoryId)) {
      throw new SyncAlreadyRunningError(repositoryId);
    }
    const status = getRepositorySyncStatus(this.database, repositoryId);
    if (status.pullRequests.status === "running" || status.issues.status === "running") {
      throw new SyncAlreadyRunningError(repositoryId);
    }
    const historyPullRequests = getRepositoryHistoryState(this.database, repositoryId, "pull_request");
    const historyIssues = getRepositoryHistoryState(this.database, repositoryId, "issue");
    if (historyPullRequests.status === "running" || historyIssues.status === "running") {
      throw new SyncAlreadyRunningError(repositoryId);
    }
  }

  private requireRepository(repositoryId: string): RepositoryRecord {
    const repository = getRepository(this.database, repositoryId);
    if (repository === null) throw new Error(`Repository is missing or disabled: ${repositoryId}`);
    return repository;
  }

  private resolveCompletion(runId: string): void {
    const pending = this.completions.get(runId);
    if (pending === undefined) return;
    try {
      pending.resolve(getSyncRun(this.database, runId));
    } catch (error: unknown) {
      this.logError("Unable to resolve sync run", error, { runId });
    }
  }

  private recordUnexpectedFailure(job: RepositorySyncJob, error: unknown): void {
    this.logError("Unexpected repository sync failure", error, {
      repositoryId: job.repository.id,
      runId: job.run.syncRunId,
    });
    if (job.kind === "forward") {
      this.forwardRunner.recordUnexpectedFailure(job, error);
    } else if (job.kind === "history") {
      this.historyRunner.recordUnexpectedFailure(job, error);
    } else {
      this.fetchPullRequestRunner.recordUnexpectedFailure(job, error);
    }
  }

  private logError(message: string, error: unknown, context: Record<string, string>): void {
    this.logger.error(message, error, context);
  }

  private timestamp(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new Error("Sync coordinator clock returned an invalid Date");
    }
    return value.toISOString();
  }

  private calendarDay(value: Date | string): string {
    const parsed = new Date(value instanceof Date ? value.toISOString() : value);
    if (!Number.isFinite(parsed.getTime())) throw new Error(`Invalid sync timestamp: ${String(value)}`);
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: this.calendarTimeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(parsed);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }

  private resolveLookbackDays(repositoryId: string): number | undefined {
    const value = this.lookbackDaysForRepository?.(repositoryId) ?? this.lookbackDays;
    if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
      throw new Error("lookbackDays must be a positive integer");
    }
    return value;
  }
}
