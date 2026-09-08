import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  atomicWrite,
  createMarkdown,
  ensureDocumentId,
  parseMarkdown,
  scanKnowledgeFiles,
  serializeDocument,
  withDocumentId,
} from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function root(): string {
  const directory = mkdtempSync(join(tmpdir(), "loongboard-knowledge-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("knowledge markdown utilities", () => {
  it("parses the loongboard_id front matter and the body title", () => {
    const parsed = parseMarkdown("---\nloongboard_id: doc_abc\n---\n\n# Title\n\nbody");
    expect(parsed.documentId).toBe("doc_abc");
    expect(parsed.title).toBe("Title");
    expect(parsed.body).toContain("body");
  });

  it("serializes and adopts front-matter-less content on first save", () => {
    const serialized = serializeDocument("doc_xyz", "# T\n\ncontent");
    expect(parseMarkdown(serialized).documentId).toBe("doc_xyz");

    const plain = "# Legacy\n\nnotes";
    const adopted = ensureDocumentId(plain, "doc_new");
    expect(adopted.documentId).toBe("doc_new");
    expect(parseMarkdown(adopted.content).documentId).toBe("doc_new");
    expect(adopted.content).toContain("# Legacy");
  });

  it("keeps an existing id when content already has one", () => {
    const adopted = ensureDocumentId("---\nloongboard_id: doc_keep\n---\n\n# Old");
    expect(adopted.content).toContain("doc_keep");
    expect(adopted.documentId).toBe("doc_keep");
  });

  it("adds loongboard_id without touching other front matter bytes", () => {
    const raw =
      "---\ntitle: Scheduler\ntags:\n  - vllm\ndraft: false\n---\n\n# Scheduler\n\nbody";
    expect(withDocumentId(raw, "doc_adopted")).toBe(
      "---\ntitle: Scheduler\ntags:\n  - vllm\ndraft: false\nloongboard_id: doc_adopted\n---\n\n# Scheduler\n\nbody",
    );
  });

  it("adopts an id-less front-matter document without stripping metadata", () => {
    const raw = "---\ntitle: Legacy\ntags:\n  - vllm\n---\n\n# Legacy\n\nbody";
    const adopted = ensureDocumentId(raw, "doc_adopt");
    expect(adopted.documentId).toBe("doc_adopt");
    expect(adopted.content).toBe(
      "---\ntitle: Legacy\ntags:\n  - vllm\nloongboard_id: doc_adopt\n---\n\n# Legacy\n\nbody",
    );
  });

  it("leaves the document untouched when the id already matches", () => {
    const raw = "---\ntitle: Scheduler\nloongboard_id: doc_same\n---\n\nbody";
    expect(withDocumentId(raw, "doc_same")).toBe(raw);
  });

  it("replaces only the stale loongboard_id line", () => {
    const raw =
      "---\ntitle: Scheduler\ntags:\n  - vllm\nloongboard_id: doc_stale\ndraft: false\n---\n\n# Scheduler\n\nbody";
    const updated = withDocumentId(raw, "doc_winner");
    expect(updated).toBe(
      "---\ntitle: Scheduler\ntags:\n  - vllm\nloongboard_id: doc_winner\ndraft: false\n---\n\n# Scheduler\n\nbody",
    );
    const originalLines = raw.split("\n");
    const updatedLines = updated.split("\n");
    expect(updatedLines.filter((line, index) => line !== originalLines[index])).toEqual([
      "loongboard_id: doc_winner",
    ]);
  });

  it("preserves CRLF line endings while adding loongboard_id", () => {
    const raw = "---\r\ntitle: Scheduler\r\n---\r\n\r\n# Scheduler";
    expect(withDocumentId(raw, "doc_crlf")).toBe(
      "---\r\ntitle: Scheduler\r\nloongboard_id: doc_crlf\r\n---\r\n\r\n# Scheduler",
    );
  });

  it("prepends minimal front matter when the document has none", () => {
    const raw = "# Legacy\n\nnotes";
    expect(withDocumentId(raw, "doc_plain")).toBe(
      "---\nloongboard_id: doc_plain\n---\n\n# Legacy\n\nnotes",
    );
  });

  it("creates documents with an id and optional heading", () => {
    const content = createMarkdown("doc_1", "Hello", "world");
    expect(parseMarkdown(content).documentId).toBe("doc_1");
    expect(content).toContain("# Hello");
  });

  it("scans only markdown files and skips excluded directories", () => {
    const directory = root();
    mkdirSync(join(directory, ".git"), { recursive: true });
    mkdirSync(join(directory, "node_modules"), { recursive: true });
    mkdirSync(join(directory, ".loong"), { recursive: true });
    writeFileSync(join(directory, "a.md"), "---\nloongboard_id: doc_a\n---\n\n# A");
    writeFileSync(join(directory, ".git", "x.md"), "# hidden");
    writeFileSync(join(directory, "node_modules", "y.md"), "# dep");
    writeFileSync(join(directory, "notes.txt"), "plain");
    const files = scanKnowledgeFiles(directory);
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("a.md");
    expect(files[0]?.documentId).toBe("doc_a");
  });

  it("writes atomically through a temp file rename", () => {
    const directory = root();
    const target = join(directory, "deep", "doc.md");
    atomicWrite(target, "---\nloongboard_id: doc_at\n---\n\n# Atomic");
    expect(parseMarkdown(readFileSync(target, "utf8")).documentId).toBe("doc_at");
    expect(readdirSync(join(directory, "deep"))).toEqual(["doc.md"]);
  });
});
