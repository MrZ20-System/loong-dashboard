import { useMemo } from "react";

/**
 * Minimal, safe Markdown renderer for chat messages and stored Markdown
 * bodies. Raw HTML is escaped (no dangerouslySetInnerHTML), so agent and
 * issue content cannot inject markup. Supports headings, paragraphs, fenced
 * and inline code, bold, links, and "- " lists — the shapes produced by
 * coding agents.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function inline(text: string): string {
  const escaped = escapeHtml(text);
  return escaped
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

function renderBlock(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let listOpen = false;
  let codeBuffer: string[] | null = null;
  let codeLanguage = "";

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push(`<p>${inline(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  };
  const closeList = () => {
    if (listOpen) {
      blocks.push("</ul>");
      listOpen = false;
    }
  };

  for (const line of lines) {
    if (codeBuffer !== null) {
      if (/^```/.test(line.trim())) {
        const language = escapeHtml(codeLanguage.trim() || "");
        blocks.push(`<pre${language ? ` data-language="${language}"` : ""}><code>${codeBuffer.join("\n")}</code></pre>`);
        codeBuffer = null;
        codeLanguage = "";
      } else {
        codeBuffer.push(escapeHtml(line));
      }
      continue;
    }
    const fence = /^```([\w+-]*)\s*$/.exec(line);
    if (fence !== null) {
      flushParagraph();
      closeList();
      codeBuffer = [];
      codeLanguage = fence[1] ?? "";
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading !== null) {
      flushParagraph();
      closeList();
      const level = heading[1].length;
      blocks.push(`<h${level}>${inline(heading[2] ?? "")}</h${level}>`);
      continue;
    }
    const listItem = /^[-*]\s+(.*)$/.exec(line);
    if (listItem !== null) {
      flushParagraph();
      if (!listOpen) {
        blocks.push("<ul>");
        listOpen = true;
      }
      blocks.push(`<li>${inline(listItem[1] ?? "")}</li>`);
      continue;
    }
    if (line.trim().length === 0) {
      flushParagraph();
      closeList();
      continue;
    }
    closeList();
    paragraph.push(line.trim());
  }
  flushParagraph();
  closeList();
  if (codeBuffer !== null) {
    const language = escapeHtml(codeLanguage.trim() || "");
    blocks.push(`<pre${language ? ` data-language="${language}"` : ""}><code>${codeBuffer.join("\n")}</code></pre>`);
  }
  return blocks.join("");
}

export function MarkdownView({ text }: { text: string }) {
  const html = useMemo(() => renderBlock(text), [text]);
  // The output of renderBlock is fully escaped HTML produced by this module.
  return <div className="markdown-view" dangerouslySetInnerHTML={{ __html: html }} />;
}
