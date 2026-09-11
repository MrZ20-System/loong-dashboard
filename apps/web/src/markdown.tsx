import { Children, isValidElement, useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import mermaid from "mermaid";
import { message, useI18n } from "./i18n";

const markdownMessages = {
  mermaidFailed: message(
    "Mermaid diagram failed: {detail}",
    "Mermaid 图表渲染失败：{detail}",
  ),
  mermaidDiagram: message("Mermaid diagram", "Mermaid 图表"),
} as const;

/**
 * Markdown renderer for chat messages, issue bodies, and Knowledge previews
 * Built on react-markdown + remark-gfm instead of the previous
 * hand-written regular-expression parser. Raw HTML stays escaped, links and
 * images are restricted to safe sources, and ` ```mermaid ` fences render
 * through mermaid.
 */
export interface MarkdownViewProps {
  /** Markdown source text. */
  text: string;
  /**
   * Repository-relative path of the Knowledge document being previewed.
   * When provided, relative image URLs are resolved against this document's
   * directory and rewritten to the Knowledge assets endpoint:
   *
   *   GET /api/knowledge/assets?path=<resolved relative path>
   *
   * Providing it also marks this source as a Knowledge document, so any
   * leading YAML front matter (LF or CRLF) is hidden and only the Markdown
   * body is rendered. The raw source passed by callers is never modified;
   * the editor and save path keep the full text including front matter.
   *
   * Non-Knowledge callers omit this prop and keep the previous safe
   * behavior: only absolute http(s) images render, and no Knowledge asset
   * URLs are synthesized.
   */
  documentPath?: string;
}

const KNOWLEDGE_ASSETS_PATH = "/api/knowledge/assets";
const SAFE_HTTP_URL = /^https?:\/\//i;

/**
 * Leading `---` front matter block that carries the stable Knowledge
 * document id and title. Capture groups:
 * 1. line ending after the opening delimiter,
 * 2. header text,
 * 3. line ending before the closing delimiter,
 * 4. optional line ending after the closing delimiter.
 *
 * Mirrors packages/knowledge so preview hides the same LF/CRLF block that the
 * server-side parser recognizes.
 */
const LEADING_FRONT_MATTER = /^---(\r?\n)([\s\S]*?)(\r?\n)---(\r?\n|$)/;

/** Return the Knowledge document body with its leading front matter removed. */
function stripFrontMatter(raw: string): string {
  const match = LEADING_FRONT_MATTER.exec(raw);
  return match === null ? raw : raw.slice((match[0] ?? "").length);
}

let mermaidInitialized = false;
let mermaidDiagramSerial = 0;

function ensureMermaidInitialized(): void {
  if (mermaidInitialized) return;
  mermaid.initialize({
    startOnLoad: false,
    theme: "default",
    securityLevel: "strict",
  });
  mermaidInitialized = true;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function textContent(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (isValidElement(node)) {
    return textContent((node.props as { children?: ReactNode }).children);
  }
  return "";
}

/** Resolve a Markdown-relative path against the document's directory. */
function resolveRelativePath(documentPath: string, relative: string): string | null {
  const slash = documentPath.lastIndexOf("/");
  const directory = slash >= 0 ? documentPath.slice(0, slash) : "";
  const parts: string[] = directory.length > 0 ? directory.split("/") : [];
  for (const raw of relative.split("/")) {
    if (raw.length === 0 || raw === ".") continue;
    if (raw === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(raw);
    }
  }
  return parts.length > 0 ? parts.join("/") : null;
}

function MarkdownLink({ href, children }: { href?: string; children?: ReactNode }): ReactNode {
  if (typeof href === "string" && SAFE_HTTP_URL.test(href)) {
    return (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  }
  // Preserve the previous behavior: only http(s) Markdown links become
  // anchors; unsafe schemes and relative links render as plain text.
  return <span>{children}</span>;
}

function MarkdownImage({
  documentPath,
  src,
  alt,
  title,
}: {
  documentPath?: string;
  src?: string;
  alt?: string;
  title?: string;
}): ReactNode {
  if (typeof src !== "string" || src.length === 0) return null;
  if (SAFE_HTTP_URL.test(src)) {
    return <img src={src} alt={alt ?? ""} title={title} loading="lazy" />;
  }
  if (documentPath !== undefined && !src.startsWith("/")) {
    const resolved = resolveRelativePath(documentPath, src);
    if (resolved !== null) {
      return (
        <img
          src={`${KNOWLEDGE_ASSETS_PATH}?path=${encodeURIComponent(resolved)}`}
          alt={alt ?? ""}
          title={title}
          loading="lazy"
        />
      );
    }
  }
  // Non-knowledge callers and unresolved paths keep the safe behavior of not
  // turning untrusted relative URLs into Knowledge asset requests.
  return null;
}

function MermaidBlock({ code }: { code: string }): ReactNode {
  const { t } = useI18n();
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const renderId = `loongboard-mermaid-${Date.now().toString(36)}-${mermaidDiagramSerial++}`;
    setError(null);
    ensureMermaidInitialized();
    void mermaid
      .render(renderId, code)
      .then(({ svg }) => {
        if (cancelled) return;
        if (hostRef.current !== null) {
          hostRef.current.innerHTML = svg;
        }
      })
      .catch((failure: unknown) => {
        if (cancelled) return;
        setError(errorMessage(failure));
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (error !== null) {
    return (
      <>
        <p role="alert" className="markdown-mermaid-error">
          {t(markdownMessages.mermaidFailed, { detail: error })}
        </p>
        <pre className="markdown-fallback-code">
          <code>{code}</code>
        </pre>
      </>
    );
  }
  return <div ref={hostRef} className="markdown-mermaid" aria-label={t(markdownMessages.mermaidDiagram)} />;
}

function MarkdownPre({ children }: { children?: ReactNode }): ReactNode {
  const codeChild = Children.toArray(children).find(isValidElement);
  if (codeChild !== undefined && codeChild !== null) {
    const props = codeChild.props as { className?: unknown; children?: ReactNode };
    const className = typeof props.className === "string" ? props.className : "";
    const language = /(?:^|\s)language-([^\s]+)/.exec(className)?.[1] ?? "";
    if (language.toLowerCase() === "mermaid") {
      return <MermaidBlock code={textContent(props.children)} />;
    }
  }
  return <pre>{children}</pre>;
}

export function MarkdownView({ text, documentPath }: MarkdownViewProps): ReactNode {
  const markdown = documentPath === undefined ? text : stripFrontMatter(text);
  return (
    <div className="markdown-view">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: MarkdownLink,
          img: (props) => <MarkdownImage documentPath={documentPath} {...props} />,
          pre: MarkdownPre,
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
