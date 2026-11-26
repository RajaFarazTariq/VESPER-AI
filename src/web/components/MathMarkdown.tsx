import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { remarkLineBreakTags } from "../lib/markdown";
import { highlightPlugin } from "./CodeMarkdown";
import { components } from "./Markdown";

/**
 * Markdown with LaTeX math (KaTeX). Loaded lazily by <Markdown> only when a reply contains math.
 * Single "$" is not math, so prices render as normal text; `trust: false` blocks KaTeX commands
 * that could add links or HTML.
 */
export default function MathMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkLineBreakTags, [remarkMath, { singleDollarTextMath: false }]]}
      rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: "ignore", trust: false, output: "mathml" }], highlightPlugin]}
      components={components}
    >
      {text}
    </ReactMarkdown>
  );
}
