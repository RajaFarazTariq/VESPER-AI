import { Check, Copy } from "lucide-react";
import { memo, useState, type ComponentProps, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

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

const components: Components = {
  pre({ children, ...props }: ComponentProps<"pre">) {
    const child = Array.isArray(children) ? children[0] : children;
    const className =
      child && typeof child === "object" && "props" in child ? String((child as { props: { className?: string } }).props.className ?? "") : "";
    const language = /language-([\w+#-]+)/.exec(className)?.[1] ?? "text";
    return (
      <pre {...props}>
        <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-1 text-xs text-[var(--text-soft)]">
          <span className="font-mono">{language}</span>
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

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
