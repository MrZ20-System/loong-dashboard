import type {
  FileContent,
  GitWorkspace,
  ReadFileInput,
} from "@loongboard/git-workspace";

const DEFAULT_MAX_ENTRIES = 512;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const ENTRY_OVERHEAD_BYTES = 256;

interface CacheEntry {
  readonly value: FileContent;
  readonly weight: number;
}

export interface FileContentCacheOptions {
  readonly maxEntries?: number;
  readonly maxBytes?: number;
}

/**
 * Bounded process-local cache for files addressed by immutable Git object ids.
 * Concurrent misses share one Git read; resolved entries use LRU eviction.
 */
export class FileContentCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<FileContent>>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private totalWeight = 0;

  constructor(
    private readonly gitWorkspace: Pick<GitWorkspace, "readFile">,
    options: FileContentCacheOptions = {},
  ) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  get(input: ReadFileInput): Promise<FileContent> {
    const key = cacheKey(input);
    const cached = this.entries.get(key);
    if (cached !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return Promise.resolve(cached.value);
    }

    const pending = this.inFlight.get(key);
    if (pending !== undefined) return pending;

    const load = this.gitWorkspace
      .readFile(input)
      .then((value) => {
        this.store(key, value);
        return value;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, load);
    return load;
  }

  private store(key: string, value: FileContent): void {
    const weight = estimateWeight(value);
    if (this.maxEntries <= 0 || this.maxBytes <= 0 || weight > this.maxBytes) {
      return;
    }
    this.entries.set(key, { value, weight });
    this.totalWeight += weight;
    while (
      this.entries.size > this.maxEntries ||
      this.totalWeight > this.maxBytes
    ) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      const oldest = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      this.totalWeight -= oldest?.weight ?? 0;
    }
  }
}

function cacheKey(input: ReadFileInput): string {
  return `${input.repositoryPath}\0${input.ref}\0${input.path}`;
}

function estimateWeight(value: FileContent): number {
  const contentWeight =
    value.content === null
      ? 0
      : Math.max(value.sizeBytes, value.content.length * 2);
  return ENTRY_OVERHEAD_BYTES + contentWeight;
}
