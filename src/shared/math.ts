/**
 * Models often write LaTeX with \[ … \] (display) and \( … \) (inline) delimiters, which Markdown
 * would otherwise turn into literal brackets. Convert them to $$ … $$, which remark-math renders.
 * Code (fenced blocks and inline `code`) is left untouched. Single "$" is never treated as math,
 * so prices like "$409.50 and $470.93" stay plain text.
 */
export function normalizeMath(markdown: string): string {
  if (!markdown.includes("\\[") && !markdown.includes("\\(")) return markdown;
  // Split into code and non-code segments; odd indexes are code.
  const parts = markdown.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part;
      return part
        .replace(/\\\[([\s\S]+?)\\\]/g, (_, expr: string) => `\n$$\n${expr.trim()}\n$$\n`)
        .replace(/\\\(([\s\S]+?)\\\)/g, (_, expr: string) => `$$${expr.trim()}$$`);
    })
    .join("");
}
