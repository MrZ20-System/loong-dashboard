import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, relative } from "node:path";

import {
  listAgentArchiveProjection,
  type AgentArchiveMessage,
  type AgentArchiveProjection,
  type AgentArchiveSessionMetadata,
  type DatabaseClient,
} from "@loongboard/database";

export interface AgentArchiveExporterOptions {
  database: DatabaseClient;
  /** Independent archive repository/path; never the DSH session home. */
  archiveRoot: string;
}

export interface AgentArchiveExportResult {
  readonly sessionCount: number;
  readonly messageCount: number;
  readonly writtenFiles: number;
  readonly unchangedFiles: number;
  readonly files: readonly string[];
}

const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function assertSafeSessionId(sessionId: string): void {
  if (!SAFE_SESSION_ID.test(sessionId) || sessionId === "." || sessionId === "..") {
    throw new Error(`Agent archive session id is not a safe directory name: ${sessionId}`);
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalize(record[key])]),
    );
  }
  return value;
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(canonicalize(value))}\n`;
}

/** Write one file atomically, avoiding a rewrite when its bytes are unchanged. */
function writeIfChanged(path: string, content: string): boolean {
  if (existsSync(path) && readFileSync(path, "utf8") === content) return false;
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, path);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
  return true;
}

function metadataFileContent(session: AgentArchiveSessionMetadata): string {
  return jsonLine(session);
}

function transcriptFileContent(messages: readonly AgentArchiveMessage[]): string {
  return messages.map((message) => jsonLine(message)).join("");
}

function sessionDirectory(archiveRoot: string, sessionId: string): string {
  assertSafeSessionId(sessionId);
  const conversationsRoot = resolve(archiveRoot, "conversations");
  const directory = resolve(conversationsRoot, sessionId);
  const relativeDirectory = relative(conversationsRoot, directory);
  if (relativeDirectory.startsWith("..") || relativeDirectory.includes("/")) {
    throw new Error(`Agent archive session path escaped archive root: ${sessionId}`);
  }
  return directory;
}

/**
 * Projects LoongBoard's normalized session index and transcript into an
 * independent archive repository. It intentionally has no DSH filesystem
 * input: normalized rows are the sole allowlist and DSH remains runtime SoT.
 */
export class AgentArchiveExporter {
  private readonly archiveRoot: string;

  constructor(private readonly options: AgentArchiveExporterOptions) {
    this.archiveRoot = resolve(options.archiveRoot);
  }

  export(sessionIds?: readonly string[]): AgentArchiveExportResult {
    const projections = listAgentArchiveProjection(this.options.database, {
      ...(sessionIds === undefined ? {} : { sessionIds }),
    });
    // Validate every target before the first write so a malformed database id
    // cannot leave a partially exported batch beside a path-safety error.
    const targets = projections.map((projection) => ({
      projection,
      directory: sessionDirectory(this.archiveRoot, projection.session.id),
    }));
    let writtenFiles = 0;
    let unchangedFiles = 0;
    const files: string[] = [];
    for (const { projection, directory } of targets) {
      const metadataPath = join(directory, "metadata.json");
      const transcriptPath = join(directory, "transcript.jsonl");
      if (writeIfChanged(metadataPath, metadataFileContent(projection.session))) {
        writtenFiles += 1;
      } else {
        unchangedFiles += 1;
      }
      if (writeIfChanged(transcriptPath, transcriptFileContent(projection.messages))) {
        writtenFiles += 1;
      } else {
        unchangedFiles += 1;
      }
      files.push(metadataPath, transcriptPath);
    }
    return {
      sessionCount: projections.length,
      messageCount: projections.reduce((total, projection) => total + projection.messages.length, 0),
      writtenFiles,
      unchangedFiles,
      files,
    };
  }
}

export type { AgentArchiveProjection };
