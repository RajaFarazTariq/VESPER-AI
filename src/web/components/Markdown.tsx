import { Check, Copy } from "lucide-react";
import { lazy, memo, Suspense, useState, type ComponentProps, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import type { Pluggable } from "unified";
import { normalizeMath } from "../../shared/math";

// KaTeX (~80 KB gzipped) is only downloaded when a reply actually contains math.
const MathMarkdown = lazy(() => import("./MathMarkdown"));
/** normalizeMath() has already turned \[ … \] and \( … \) into $$ … $$. */
const MATH_PATTERN = /\$\$/;

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // clipboard blocked; nothing useful to do
        }
      }}
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-[var(--text-soft)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
      <span className="sr-only sm:not-sr-only">{copied ? "Copied" : label}</span>
    </button>
  );
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) {
    return textOf((node as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}

export const components: Components = {
  pre({ children, ...props }: ComponentProps<"pre">) {
    const child = Array.isArray(children) ? children[0] : children;
    const className =
      child && typeof child === "object" && "props" in child ? String((child as { props: { className?: string } }).props.className ?? "") : "";
    const language = /language-([\w+#-]+)/.exec(className)?.[1] ?? "text";
    return (
      <pre {...props}>
        <div className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--bg-soft)] py-1 pl-4 pr-1.5 text-xs text-[var(--text-soft)]">
          <span className="font-mono text-[11.5px] tracking-wide">{language}</span>
          <CopyButton text={textOf(children).replace(/\n$/, "")} />
        </div>
        {children}
      </pre>
    );
  },
  a({ href, children }) {
    const safe = href && /^(https?:|mailto:)/i.test(href) ? href : undefined;
    return (
      <a href={safe} target="_blank" rel="noopener noreferrer nofollow">
        {children}
      </a>
    );
  },
  // Model output can't load remote images: that would leak data to arbitrary servers.
  img({ src, alt }) {
    const url = typeof src === "string" && /^https?:/i.test(src) ? src : undefined;
    return url ? (
      <a href={url} target="_blank" rel="noopener noreferrer nofollow">
        [image: {alt || url}]
      </a>
    ) : (
      <span>[image: {alt}]</span>
    );
  },
};

export const highlightPlugin: Pluggable = [rehypeHighlight, { detect: false, ignoreMissing: true }];

function PlainMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[highlightPlugin]} components={components}>
      {text}
    </ReactMarkdown>
  );
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const normalized = normalizeMath(text);
  return (
    <div className="md">
      {MATH_PATTERN.test(normalized) ? (
        <Suspense fallback={<PlainMarkdown text={normalized} />}>
          <MathMarkdown text={normalized} />
        </Suspense>
      ) : (
        <PlainMarkdown text={normalized} />
      )}
    </div>
  );
});
