import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { components, highlightPlugin } from "./Markdown";

/**
 * Markdown with LaTeX math (KaTeX). Loaded lazily by <Markdown> only when a reply contains math.
 * Single "$" is not math, so prices render as normal text; `trust: false` blocks KaTeX commands
 * that could add links or HTML.
 */
export default function MathMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: false }]]}
      rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: "ignore", trust: false, output: "mathml" }], highlightPlugin]}
      components={components}
    >
      {text}
    </ReactMarkdown>
  );
}
