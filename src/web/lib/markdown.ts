/** Small Markdown helpers for answers (kept free of React so they can be unit-tested). */

type MdNode = { type: string; value?: string; children?: MdNode[] };
const LINE_BREAK_TAG = /^<br\s*\/?>$/i;

/**
 * Models often write <br> for a line break inside a table cell. Raw HTML from a model is never rendered (safety), so
 * it used to show as the text "<br>". This remark plugin turns exactly that tag into a real line break; any other
 * HTML stays plain text.
 */
export function remarkLineBreakTags() {
  return (tree: MdNode) => {
    const walk = (node: MdNode) => {
      if (!node.children) return;
      node.children = node.children.map((child) =>
        child.type === "html" && LINE_BREAK_TAG.test((child.value ?? "").trim()) ? { type: "break" } : child,
      );
      node.children.forEach(walk);
    };
    walk(tree);
  };
}
