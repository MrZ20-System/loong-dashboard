import {
  addDaysToCalendarDate,
  archiveBatch,
  calendarDateToUtc,
  createMaintenanceRun,
  listMaintenanceRuns,
  listRepositories,
  previewArchive,
  previewRuntimeHistoryPurge,
  purgeRuntimeHistoryBatch,
  requireMaintenanceRun,
  restoreIssue,
  restorePullRequest,
  type ArchiveBatchResult,
  type DatabaseClient,
  type MaintenanceRunRecord,
  updateMaintenanceRun,
  utcDateToCalendarDate,
} from "@loongboard/database";
import {
  archivePreviewRequestSchema,
  archiveRunCreateSchema,
  archivePreviewResponseSchema,
  RUNTIME_HISTORY_KEEP_LATEST,
  RUNTIME_HISTORY_RETENTION_DAYS,
  maintenanceRunSchema,
  type ArchivePreviewRequest,
  type ArchivePreviewResponse,
  type ArchiveRunCreate,
  type MaintenanceRun,
  type RepositoryRetentionSettings,
  type RestoreMetadataResponse,
  runtimeHistoryPurgePreviewRequestSchema,
  runtimeHistoryPurgePreviewResponseSchema,
  runtimeHistoryPurgeRunCreateSchema,
  type RuntimeHistoryPurgePreviewRequest,
  type RuntimeHistoryPurgePreviewResponse,
  type RuntimeHistoryPurgeRunCreate,
  restoreMetadataResponseSchema,
} from "@loongboard/contracts";

const DEFAULT_BATCH_SIZE = 250;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;

export interface MetadataMaintenanceServiceOptions {
  database: DatabaseClient;
  calendarTimeZone: string;
  batchSize?: number;
  now?: () => Date;
  /** Includes queued foreground/history work, not just DB stream status. */
  isSyncActive?: (repositoryId: string) => boolean;
  /** Lets the coordinator hold one repository admission while a batch runs. */
  setRepositoryMaintenanceActive?: (repositoryId: string, active: boolean) => void;
  logger?: { error(...arguments_: readonly unknown[]): void };
}

export interface MetadataMaintenanceStartResult {
  run: MaintenanceRunRecord;
  completion: Promise<MaintenanceRunRecord>;
}

type QueuedMaintenanceJob =
  | Omit<ArchiveMaintenanceJob, "launched" | "resolve" | "reject">
  | Omit<RuntimeHistoryMaintenanceJob, "launched" | "resolve" | "reject">;

interface BaseMaintenanceJob {
  repositoryId: string;
  launched: boolean;
  resolve: (run: MaintenanceRunRecord) => void;
  reject: (error: unknown) => void;
}

interface ArchiveMaintenanceJob extends BaseMaintenanceJob {
  kind: "archive";
  selection: ArchiveRunCreate;
}

interface RuntimeHistoryMaintenanceJob extends BaseMaintenanceJob {
  kind: "runtime-history";
  selection: RuntimeHistoryPurgeRunCreate;
}

type MaintenanceJob = ArchiveMaintenanceJob | RuntimeHistoryMaintenanceJob;

export class MetadataMaintenanceClosedError extends Error {
  readonly code = "METADATA_MAINTENANCE_CLOSED" as const;

  constructor() {
    super("Metadata maintenance is closed");
    this.name = "MetadataMaintenanceClosedError";
  }
}

/**
 * Bounded archive worker for terminal repository metadata.
 *
 * This is intentionally a small service rather than a second scheduler/job
 * framework: durable run state lives in SQLite, while one in-memory promise
 * owns each currently executing run. Daily admission belongs to Scheduler.
 */
export class MetadataMaintenanceService {
  private readonly database: DatabaseClient;
  private readonly calendarTimeZone: string;
  private readonly batchSize: number;
  private readonly now: () => Date;
  private readonly isSyncActive: (repositoryId: string) => boolean;
  private readonly setRepositoryMaintenanceActive:
    | ((repositoryId: string, active: boolean) => void)
    | undefined;
  private readonly logger: { error(...arguments_: readonly unknown[]): void };
  private readonly jobs = new Map<string, MaintenanceJob>();
  private readonly completions = new Map<string, Promise<MaintenanceRunRecord>>();
  /** One metadata mutation flow at a time for each repository. */
  private readonly repositoryQueues = new Map<string, string[]>();
  private readonly runningRepositories = new Set<string>();
  private closed = false;

  constructor(options: MetadataMaintenanceServiceOptions) {
    this.database = options.database;
    this.calendarTimeZone = options.calendarTimeZone;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    if (!Number.isInteger(this.batchSize) || this.batchSize < 200 || this.batchSize > 500) {
      throw new Error("Metadata maintenance batchSize must be an integer between 200 and 500");
    }
    this.now = options.now ?? (() => new Date());
    this.isSyncActive = options.isSyncActive ?? (() => false);
    this.setRepositoryMaintenanceActive = options.setRepositoryMaintenanceActive;
    this.logger = options.logger ?? console;
  }

  /** Mark runs abandoned by a previous process before scheduling resumes. */
  recoverInterruptedRuns(): void {
    const finishedAt = this.timestamp();
    for (const repository of listRepositories(this.database)) {
      for (const run of listMaintenanceRuns(this.database, repository.id, 100)) {
        if (run.status !== "queued" && run.status !== "running") continue;
        updateMaintenanceRun(this.database, run.id, {
          status: "interrupted",
          finishedAt,
          error: "Interrupted by server restart",
        });
      }
    }
  }

  preview(repositoryId: string, request: ArchivePreviewRequest): ArchivePreviewResponse {
    const input = archivePreviewRequestSchema.parse(request);
    const cutoff = calendarDateToUtc(input.date, this.calendarTimeZone).from;
    const preview = previewArchive(this.database, {
      repositoryId,
      cutoff,
      includeMergedPrs: input.includeMergedPrs,
      includeClosedPrs: input.includeClosedPrs,
      includeClosedIssues: input.includeClosedIssues,
    });
    return archivePreviewResponseSchema.parse({
      repositoryId: preview.repositoryId,
      cutoff: preview.cutoff,
      scopes: preview.scopes,
      mergedPrCount: preview.mergedPrCount,
      closedPrCount: preview.closedPrCount,
      closedIssueCount: preview.closedIssueCount,
      prFileRows: preview.prFileRows,
      issueCommentRows: preview.issueCommentRows,
      prPayloadCount: preview.prPayloadCount,
      issuePayloadCount: preview.issuePayloadCount,
      date: input.date,
      calendarTimeZone: this.calendarTimeZone,
    });
  }

  previewRuntimeHistory(
    repositoryId: string,
    request: RuntimeHistoryPurgePreviewRequest = {},
  ): RuntimeHistoryPurgePreviewResponse {
    const input = runtimeHistoryPurgePreviewRequestSchema.parse(request);
    const asOf = input.asOf ?? this.timestamp();
    const preview = previewRuntimeHistoryPurge(this.database, {
      repositoryId,
      asOf,
      retentionDays: RUNTIME_HISTORY_RETENTION_DAYS,
      keepLatest: RUNTIME_HISTORY_KEEP_LATEST,
    });
    return runtimeHistoryPurgePreviewResponseSchema.parse({ ...preview, asOf });
  }

  start(
    repositoryId: string,
    request: ArchiveRunCreate,
    trigger: "manual" | "automatic" = "manual",
  ): MetadataMaintenanceStartResult {
    if (this.closed) throw new MetadataMaintenanceClosedError();
    const input = archiveRunCreateSchema.parse(request);
    const cutoff = calendarDateToUtc(input.date, this.calendarTimeZone).from;
    const run = createMaintenanceRun(this.database, {
      repositoryId,
      kind: input.prune ? "prune" : "archive",
      trigger,
      cutoff,
      selector: {
        date: input.date,
        includeMergedPrs: input.includeMergedPrs,
        includeClosedPrs: input.includeClosedPrs,
        includeClosedIssues: input.includeClosedIssues,
        prune: input.prune,
      },
      requestedAt: this.timestamp(),
    });
    return this.enqueue(run, { repositoryId, kind: "archive", selection: input });
  }

  startRuntimeHistory(
    repositoryId: string,
    request: RuntimeHistoryPurgeRunCreate = {},
    trigger: "manual" | "automatic" = "manual",
  ): MetadataMaintenanceStartResult {
    if (this.closed) throw new MetadataMaintenanceClosedError();
    const input = runtimeHistoryPurgeRunCreateSchema.parse(request);
    const asOf = input.asOf ?? this.timestamp();
    const cutoff = new Date(
      Date.parse(asOf) - RUNTIME_HISTORY_RETENTION_DAYS * DAY_MILLISECONDS,
    ).toISOString();
    const run = createMaintenanceRun(this.database, {
      repositoryId,
      kind: "purge_runtime_history",
      trigger,
      cutoff,
      selector: {
        asOf,
        retentionDays: RUNTIME_HISTORY_RETENTION_DAYS,
        keepLatest: RUNTIME_HISTORY_KEEP_LATEST,
        runsDeleted: 0,
      },
      requestedAt: this.timestamp(),
    });
    return this.enqueue(run, {
      repositoryId,
      kind: "runtime-history",
      selection: { asOf },
    });
  }

  async runAndWait(
    repositoryId: string,
    request: ArchiveRunCreate,
    trigger: "manual" | "automatic" = "automatic",
  ): Promise<MaintenanceRunRecord> {
    return (this.start(repositoryId, request, trigger)).completion;
  }

  async runRuntimeHistoryAndWait(
    repositoryId: string,
    request: RuntimeHistoryPurgeRunCreate = {},
    trigger: "manual" | "automatic" = "automatic",
  ): Promise<MaintenanceRunRecord> {
    return this.startRuntimeHistory(repositoryId, request, trigger).completion;
  }

  automaticRequest(
    settings: RepositoryRetentionSettings,
    now = this.now(),
  ): ArchiveRunCreate {
    if (!settings.automaticArchiveEnabled) {
      throw new Error("Automatic metadata maintenance is disabled");
    }
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error("Metadata maintenance clock returned an invalid Date");
    }
    const localToday = utcDateToCalendarDate(now.toISOString(), this.calendarTimeZone);
    return archiveRunCreateSchema.parse({
      date: addDaysToCalendarDate(localToday, -settings.archiveAfterDays),
      includeMergedPrs: settings.includeMergedPrs,
      includeClosedPrs: settings.includeClosedPrs,
      includeClosedIssues: settings.includeClosedIssues,
      prune: settings.prunePayloadWhenArchived,
    });
  }

  get(runId: string): MaintenanceRun {
    return maintenanceRunSchema.parse(requireMaintenanceRun(this.database, runId));
  }

  list(repositoryId: string, limit = 50): MaintenanceRun[] {
    return listMaintenanceRuns(this.database, repositoryId, limit).map((run) =>
      maintenanceRunSchema.parse(run),
    );
  }

  restorePullRequest(repositoryId: string, number: number): RestoreMetadataResponse {
    return restoreMetadataResponseSchema.parse(
      restorePullRequest(this.database, repositoryId, number),
    );
  }

  restoreIssue(repositoryId: string, number: number): RestoreMetadataResponse {
    return restoreMetadataResponseSchema.parse(
      restoreIssue(this.database, repositoryId, number),
    );
  }

  async waitForIdle(): Promise<void> {
    while (this.jobs.size > 0) {
      await Promise.allSettled([...this.completions.values()]);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const [runId, job] of [...this.jobs]) {
      if (job.launched) continue;
      this.interruptRun(runId);
      job.resolve(requireMaintenanceRun(this.database, runId));
      this.jobs.delete(runId);
      this.completions.delete(runId);
    }
    this.repositoryQueues.clear();
    await this.waitForIdle();
  }

  private enqueue(
    run: MaintenanceRunRecord,
    jobInput: QueuedMaintenanceJob,
  ): MetadataMaintenanceStartResult {
    let resolveCompletion!: (value: MaintenanceRunRecord) => void;
    let rejectCompletion!: (error: unknown) => void;
    const completion = new Promise<MaintenanceRunRecord>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    this.completions.set(run.id, completion);
    this.jobs.set(run.id, {
      ...jobInput,
      launched: false,
      resolve: resolveCompletion,
      reject: rejectCompletion,
    });
    const queue = this.repositoryQueues.get(jobInput.repositoryId) ?? [];
    queue.push(run.id);
    this.repositoryQueues.set(jobInput.repositoryId, queue);
    // Keep the HTTP caller on the durable queued boundary. The first batch is
    // launched on the next turn of the event loop, after any earlier run for
    // this repository has released its admission.
    setImmediate(() => this.pumpRepository(jobInput.repositoryId));
    return { run, completion };
  }

  private pumpRepository(repositoryId: string): void {
    if (this.closed || this.runningRepositories.has(repositoryId)) return;
    const queue = this.repositoryQueues.get(repositoryId);
    if (queue === undefined) return;
    while (queue.length > 0) {
      const runId = queue.shift()!;
      const job = this.jobs.get(runId);
      if (job === undefined) continue;
      if (queue.length === 0) this.repositoryQueues.delete(repositoryId);
      this.runningRepositories.add(repositoryId);
      job.launched = true;
      void this.execute(runId, job).then(
        (completed) => job.resolve(completed),
        (error) => job.reject(error),
      ).finally(() => {
        this.jobs.delete(runId);
        this.completions.delete(runId);
        this.runningRepositories.delete(repositoryId);
        setImmediate(() => this.pumpRepository(repositoryId));
      });
      return;
    }
    this.repositoryQueues.delete(repositoryId);
  }

  private async execute(
    runId: string,
    job: MaintenanceJob,
  ): Promise<MaintenanceRunRecord> {
    let active = false;
    let prCount = 0;
    let issueCount = 0;
    let filesDeleted = 0;
    let commentsDeleted = 0;
    try {
      await this.waitUntilSyncIdle(job.repositoryId);
      if (this.closed) throw new MetadataMaintenanceClosedError();
      this.setRepositoryMaintenanceActive?.(job.repositoryId, true);
      active = true;
      // Recheck after taking the coordinator admission to close the race
      // between a foreground request and this worker's first batch.
      if (this.isSyncActive(job.repositoryId)) {
        this.setRepositoryMaintenanceActive?.(job.repositoryId, false);
        active = false;
        await this.waitUntilSyncIdle(job.repositoryId);
        if (this.closed) throw new MetadataMaintenanceClosedError();
        this.setRepositoryMaintenanceActive?.(job.repositoryId, true);
        active = true;
      }
      updateMaintenanceRun(this.database, runId, {
        status: "running",
        startedAt: this.timestamp(),
        error: null,
      });
      while (true) {
        if (this.closed) throw new MetadataMaintenanceClosedError();
        if (this.isSyncActive(job.repositoryId)) {
          this.setRepositoryMaintenanceActive?.(job.repositoryId, false);
          active = false;
          await this.waitUntilSyncIdle(job.repositoryId);
          if (this.closed) throw new MetadataMaintenanceClosedError();
          this.setRepositoryMaintenanceActive?.(job.repositoryId, true);
          active = true;
        }
        const batch = job.kind === "archive"
          ? archiveBatch(this.database, {
              repositoryId: job.repositoryId,
              cutoff: calendarDateToUtc(job.selection.date, this.calendarTimeZone).from,
              includeMergedPrs: job.selection.includeMergedPrs,
              includeClosedPrs: job.selection.includeClosedPrs,
              includeClosedIssues: job.selection.includeClosedIssues,
              archiveAt: this.timestamp(),
              prune: job.selection.prune,
              batchSize: this.batchSize,
            })
          : purgeRuntimeHistoryBatch(this.database, {
              repositoryId: job.repositoryId,
              asOf: job.selection.asOf,
              retentionDays: RUNTIME_HISTORY_RETENTION_DAYS,
              keepLatest: RUNTIME_HISTORY_KEEP_LATEST,
              batchSize: this.batchSize,
              maintenanceRunId: runId,
            });
        if (job.kind === "archive") {
          this.accumulate(batch as ArchiveBatchResult, (next) => {
            prCount += next.prCount;
            issueCount += next.issueCount;
            filesDeleted += next.filesDeleted;
            commentsDeleted += next.commentsDeleted;
          });
          updateMaintenanceRun(this.database, runId, {
            prCount,
            issueCount,
            filesDeleted,
            commentsDeleted,
          });
        }
        // Release at every batch boundary. Foreground coordinator work can
        // therefore enter between archive transactions.
        this.setRepositoryMaintenanceActive?.(job.repositoryId, false);
        active = false;
        await immediate();
        if (this.closed) throw new MetadataMaintenanceClosedError();
        if (!batch.hasMore) {
          return updateMaintenanceRun(this.database, runId, {
            status: "completed",
            finishedAt: this.timestamp(),
            prCount,
            issueCount,
            filesDeleted,
            commentsDeleted,
            error: null,
          });
        }
        await this.waitUntilSyncIdle(job.repositoryId);
        if (this.closed) throw new MetadataMaintenanceClosedError();
        this.setRepositoryMaintenanceActive?.(job.repositoryId, true);
        active = true;
      }
    } catch (error: unknown) {
      this.setRepositoryMaintenanceActive?.(job.repositoryId, false);
      active = false;
      if (error instanceof MetadataMaintenanceClosedError || this.closed) {
        return this.interruptRun(runId, { prCount, issueCount, filesDeleted, commentsDeleted });
      }
      const message = compactError(error);
      this.logger.error("Metadata maintenance failed", message, { repositoryId: job.repositoryId, runId });
      return updateMaintenanceRun(this.database, runId, {
        status: "failed",
        finishedAt: this.timestamp(),
        prCount,
        issueCount,
        filesDeleted,
        commentsDeleted,
        error: message,
      });
    } finally {
      if (active) this.setRepositoryMaintenanceActive?.(job.repositoryId, false);
    }
  }

  private waitUntilSyncIdle(repositoryId: string): Promise<void> {
    if (!this.isSyncActive(repositoryId)) return Promise.resolve();
    if (this.closed) return Promise.reject(new MetadataMaintenanceClosedError());
    return immediate().then(() => this.waitUntilSyncIdle(repositoryId));
  }

  private interruptRun(
    runId: string,
    counters: Partial<Pick<MaintenanceRunRecord, "prCount" | "issueCount" | "filesDeleted" | "commentsDeleted">> = {},
  ): MaintenanceRunRecord {
    const run = requireMaintenanceRun(this.database, runId);
    if (run.status === "queued" || run.status === "running") {
      return updateMaintenanceRun(this.database, runId, {
        status: "interrupted",
        finishedAt: this.timestamp(),
        error: "Interrupted by server close",
        ...counters,
      });
    }
    return run;
  }

  private accumulate(
    _batch: ArchiveBatchResult,
    update: (result: ArchiveBatchResult) => void,
  ): void {
    // Keep this small seam explicit: it makes counter updates easy to test
    // without exposing the database transaction or payload details.
    update(_batch);
  }

  private timestamp(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new Error("Metadata maintenance clock returned an invalid Date");
    }
    return value.toISOString();
  }
}

function immediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function compactError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.replace(/[\r\n\t]+/g, " ").trim();
  return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized || "Maintenance failed";
}
