/**
 * Reading uploaded files in the browser: knowledge-base files (admin panel) and documents attached to a chat
 * (v0.16.0, lib/documents.ts, with stricter limits). The free Workers plan gives the server only ~10 ms of CPU per
 * request, far too little to parse a PDF, so files are read here and only their text is sent. Returns units with
 * locations (PDF pages, Word/Markdown sections, CSV row blocks); shared/chunking.ts turns them into passages. The PDF
 * and Word libraries are large, so they load only when such a file is added.
 */
import { csvUnits, markdownUnits, normalizeText, type TextUnit } from "../../shared/chunking";
import type { KnowledgeDocKind } from "../../shared/types";

export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_PDF_PAGES = 1_000;
export const ACCEPTED_FILES = ".pdf,.docx,.txt,.md,.markdown,.csv";

/** A problem with the file itself, explained in plain words. */
export class ExtractError extends Error {}

export type FileKind = Exclude<KnowledgeDocKind, "web">;

export interface ExtractedFile {
  kind: FileKind;
  pages: number | null;
  units: TextUnit[];
}

/**
 * Limits and wording for one caller. The knowledge base uses the defaults; documents in chat pass smaller limits
 * so a file that is too big stops at once, before every page is read.
 */
export interface ExtractOptions {
  /** Largest file (default 50 MB). Checked before anything is read. */
  maxBytes?: number;
  /** Most PDF pages (default 1,000), and the message for a PDF with more. */
  maxPages?: number;
  tooManyPages?: (pages: number, max: number) => string;
  /** Most characters of text: a PDF stops being read as soon as it has more. */
  maxChars?: number;
  tooMuchText?: string;
  /** The message for a PDF or Word file without readable text. */
  noText?: string;
  /** Stops reading a PDF between pages (the user removed the file). */
  signal?: AbortSignal;
}

export function kindOf(fileName: string): FileKind | null {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (ext === "txt") return "txt";
  if (ext === "md" || ext === "markdown") return "md";
  if (ext === "csv") return "csv";
  return null;
}

export async function extractFile(file: File, onProgress?: (message: string) => void, options: ExtractOptions = {}): Promise<ExtractedFile> {
  const kind = kindOf(file.name);
  if (!kind) {
    throw new ExtractError(
      file.name.toLowerCase().endsWith(".doc") || file.name.toLowerCase().endsWith(".xlsx") || file.name.toLowerCase().endsWith(".xls")
        ? "Old Word (.doc) and Excel files aren't supported. Save as .docx (Word) or .csv (Excel) first."
        : "This file type isn't supported. Use PDF, Word (.docx), text (.txt), Markdown (.md) or CSV.",
    );
  }
  if (file.size === 0) throw new ExtractError("The file is empty.");
  const maxBytes = options.maxBytes ?? MAX_FILE_BYTES;
  if (file.size > maxBytes) {
    throw new ExtractError(`The file is larger than ${Math.round(maxBytes / (1024 * 1024))} MB. Split it into smaller files.`);
  }
  // Text, Markdown and Word: far more text than allowed is refused before it is split into passages, which could freeze
  // the page for seconds on a big file. The exact count is checked on the passages afterwards (spaces and blank lines
  // that are tidied away rarely make up a third of a file).
  const notTooLong = (text: string) => {
    if (options.maxChars !== undefined && text.length > options.maxChars * 1.5) {
      throw new ExtractError(options.tooMuchText ?? "The file has too much text. Split it into smaller files.");
    }
    return text;
  };
  switch (kind) {
    case "pdf":
      return extractPdf(file, onProgress, options);
    case "docx":
      onProgress?.("Reading the document…");
      return { kind, pages: null, units: markdownUnits(notTooLong(await docxToMarkdown(file, options.noText))) };
    case "md":
      return { kind, pages: null, units: markdownUnits(notTooLong(await file.text())) };
    case "csv":
      return { kind, pages: null, units: csvUnits(await file.text()) };
    default:
      return { kind, pages: null, units: [{ location: "", text: notTooLong(await file.text()) }] };
  }
}

async function extractPdf(file: File, onProgress: ((message: string) => void) | undefined, options: ExtractOptions): Promise<ExtractedFile> {
  const maxPages = options.maxPages ?? MAX_PDF_PAGES;
  onProgress?.("Opening the PDF…");
  const [pdfjs, worker] = await Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  // No WebAssembly: the site's security policy doesn't allow it, and reading text doesn't need it.
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), useWasm: false });
  let doc: Awaited<typeof task.promise>;
  try {
    doc = await task.promise;
  } catch (error) {
    await task.destroy().catch(() => {});
    if ((error as { name?: string })?.name === "PasswordException") {
      throw new ExtractError("The PDF is password-protected. Save a copy without the password and try again.");
    }
    throw new ExtractError("The PDF couldn't be opened. It may be damaged.");
  }
  try {
    if (doc.numPages > maxPages) {
      throw new ExtractError(
        options.tooManyPages?.(doc.numPages, maxPages) ?? `The PDF has ${doc.numPages} pages; the limit is ${maxPages}. Split it into smaller files.`,
      );
    }
    const units: TextUnit[] = [];
    let chars = 0;
    for (let n = 1; n <= doc.numPages; n++) {
      options.signal?.throwIfAborted();
      onProgress?.(`Reading page ${n} of ${doc.numPages}…`);
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items) {
        if ("str" in item) text += item.str + (item.hasEOL ? "\n" : "");
      }
      page.cleanup();
      const clean = normalizeText(text);
      chars += clean.length;
      if (options.maxChars !== undefined && chars > options.maxChars) {
        throw new ExtractError(options.tooMuchText ?? "The PDF has too much text. Split it into smaller files.");
      }
      if (clean) units.push({ location: `page ${n}`, text: clean });
    }
    if (chars < Math.max(50, doc.numPages * 20)) {
      throw new ExtractError(options.noText ?? "This PDF has no readable text (it looks like scanned images). Scanned PDFs can't be read yet.");
    }
    return { kind: "pdf", pages: doc.numPages, units };
  } finally {
    await task.destroy().catch(() => {});
  }
}

/** Word → Markdown-like text: headings become "#" lines (cited as sections), lists "- ", table rows "a | b". */
async function docxToMarkdown(file: File, noText?: string): Promise<string> {
  const mammoth = (await import("mammoth/mammoth.browser.min.js")).default;
  let html: string;
  try {
    html = (await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() })).value;
  } catch {
    throw new ExtractError("The Word file couldn't be read. It may be damaged or not a real .docx file.");
  }
  const body = new DOMParser().parseFromString(html, "text/html").body;
  const lines: string[] = [];
  const text = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ").trim();
  const walk = (parent: Element) => {
    for (const el of Array.from(parent.children)) {
      const tag = el.tagName.toLowerCase();
      const heading = /^h([1-6])$/.exec(tag);
      if (heading) {
        const t = text(el);
        if (t) lines.push("", `${"#".repeat(Number(heading[1]))} ${t}`);
      } else if (tag === "table") {
        for (const row of Array.from(el.querySelectorAll("tr"))) {
          const cells = Array.from(row.children).map(text).filter(Boolean);
          if (cells.length) lines.push(cells.join(" | "));
        }
      } else if (tag === "ul" || tag === "ol") {
        for (const li of Array.from(el.children)) {
          const t = text(li);
          if (t) lines.push(`- ${t}`);
        }
      } else if (tag === "p") {
        const t = text(el);
        if (t) lines.push(t);
      } else {
        walk(el);
      }
    }
  };
  walk(body);
  const markdown = lines.join("\n").trim();
  if (!markdown) throw new ExtractError(noText ?? "The Word file has no readable text.");
  return markdown;
}
