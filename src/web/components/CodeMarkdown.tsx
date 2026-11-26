import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import type { Pluggable } from "unified";
import { remarkLineBreakTags } from "../lib/markdown";
import { components } from "./Markdown";

/** Colours for code blocks that name their language ("```ts"); others stay plain (`detect: false`). */
export const highlightPlugin: Pluggable = [rehypeHighlight, { detect: false, ignoreMissing: true }];

/**
 * Markdown with highlighted code blocks (v0.19.0). The highlighter (highlight.js, ~40 KB gzipped) is only downloaded
 * when a reply has a code block that names its language: <Markdown> loads this lazily and shows the same text
 * without colours meanwhile.
 */
export default function CodeMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkLineBreakTags]} rehypePlugins={[highlightPlugin]} components={components}>
      {text}
    </ReactMarkdown>
  );
}
