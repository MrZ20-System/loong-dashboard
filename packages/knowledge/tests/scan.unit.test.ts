import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { scanKnowledgeFiles } from "../src/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("scanKnowledgeFiles", () => {
  it("returns one reusable content snapshot for each Markdown file", () => {
    const root = mkdtempSync(join(tmpdir(), "loongboard-knowledge-unit-"));
    roots.push(root);
    mkdirSync(join(root, "notes"));
    mkdirSync(join(root, ".git"));
    const content = "---\nloongboard_id: doc_alpha\n---\n\n# Alpha\n\nBody\n";
    writeFileSync(join(root, "notes", "alpha.md"), content, "utf8");
    writeFileSync(join(root, ".git", "ignored.md"), "# ignored\n", "utf8");

    const files = scanKnowledgeFiles(root);

    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      path: "notes/alpha.md",
      documentId: "doc_alpha",
      title: "Alpha",
      content,
      contentHash: createHash("sha256").update(content).digest("hex"),
    });
  });
});
