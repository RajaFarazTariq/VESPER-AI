/**
 * Documents in chat (v0.16.0), the browser side that needs nothing from the page itself: which list an attached
 * file goes to, the wording on document chips, and the limits checked before reading and before uploading.
 */
import { describe, expect, it } from "vitest";
import { DOCUMENT_LIMITS } from "../src/shared/documents";
import {
  documentBatches,
  documentProblem,
  documentSubtitle,
  passagesProblem,
  rejectedFileMessage,
  routeFiles,
} from "../src/web/lib/attachments";

const file = (name: string, body = "Some text.", type = "") => new File([body], name, { type });
const allOn = { images: true, tables: true, documents: true };
const names = (files: File[]) => files.map((f) => f.name);

describe("routing attached files", () => {
  it("sends images, spreadsheets and documents to their own lists", () => {
    const routed = routeFiles(
      [
        file("photo.png", "x", "image/png"),
        file("data.csv"),
        file("book.xlsx"),
        file("report.pdf"),
        file("memo.docx"),
        file("notes.txt"),
        file("readme.md"),
        file("guide.markdown"),
        file("old.doc"),
        file("slides.pptx"),
      ],
      allOn,
    );
    expect(names(routed.images)).toEqual(["photo.png"]);
    expect(names(routed.tables)).toEqual(["data.csv", "book.xlsx"]);
    expect(names(routed.documents)).toEqual(["report.pdf", "memo.docx", "notes.txt", "readme.md", "guide.markdown"]);
    expect(names(routed.rejected)).toEqual(["old.doc", "slides.pptx"]);
  });

  it("a CSV file is never a document, and switched-off kinds take nothing", () => {
    const routed = routeFiles([file("data.csv"), file("photo.jpg", "x", "image/jpeg"), file("report.pdf")], { images: false, tables: false, documents: true });
    expect(names(routed.documents)).toEqual(["report.pdf"]);
    expect(names(routed.rejected)).toEqual(["data.csv", "photo.jpg"]);
    expect(names(routeFiles([file("report.pdf")], { images: true, tables: true, documents: false }).rejected)).toEqual(["report.pdf"]);
  });

  it("explains what can be attached", () => {
    expect(rejectedFileMessage(file("slides.pptx"), allOn)).toBe(
      '"slides.pptx" can\'t be attached. Attach images, a spreadsheet (CSV, Excel or OpenDocument) or a document (PDF, Word, text or Markdown).',
    );
    expect(rejectedFileMessage(file("x.zip"), { images: false, tables: true, documents: false })).toBe(
      '"x.zip" can\'t be attached. Attach a spreadsheet (CSV, Excel or OpenDocument).',
    );
    expect(rejectedFileMessage(file("old.DOC"), allOn)).toContain("Save it as .docx");
  });
});

describe("document chips and limits", () => {
  it("describes each kind", () => {
    expect(documentSubtitle({ kind: "pdf", pages: 12 })).toBe("PDF · 12 pages");
    expect(documentSubtitle({ kind: "pdf", pages: 1 })).toBe("PDF · 1 page");
    expect(documentSubtitle({ kind: "pdf", pages: null })).toBe("PDF");
    expect(documentSubtitle({ kind: "docx", pages: null })).toBe("Word document");
    expect(documentSubtitle({ kind: "txt" })).toBe("Text");
    expect(documentSubtitle({ kind: "md" })).toBe("Markdown");
  });

  it("checks the type, an empty file and the size before reading", () => {
    expect(documentProblem(file("report.pdf"))).toBeNull();
    expect(documentProblem(file("data.csv"))).toContain("can't be attached as a document");
    expect(documentProblem(file("empty.txt", ""))).toBe("The file is empty.");
    expect(documentProblem({ name: "big.pdf", size: DOCUMENT_LIMITS.fileBytes + 1 } as File)).toBe(
      "The file is larger than 20 MB. Split it into smaller files.",
    );
  });

  it("checks the passages against the server's limits", () => {
    expect(passagesProblem([])).toContain("no readable text");
    expect(passagesProblem([{ seq: 0, location: "", text: "x".repeat(1000) }])).toBeNull();
    const many = Array.from({ length: DOCUMENT_LIMITS.chunks + 1 }, (_, seq) => ({ seq, location: "", text: "x" }));
    expect(passagesProblem(many)).toContain("too large");
    const big = Array.from({ length: 300 }, (_, seq) => ({ seq, location: "", text: "x".repeat(3_500) }));
    expect(passagesProblem(big)).toContain("too large");
  });

  it("batches at most 50 passages and about 100,000 characters", () => {
    const small = Array.from({ length: 120 }, (_, seq) => ({ seq, location: "", text: "x" }));
    expect(documentBatches(small).map((b) => b.length)).toEqual([50, 50, 20]);
    const large = Array.from({ length: 60 }, (_, seq) => ({ seq, location: "", text: "x".repeat(3_000) }));
    const batches = documentBatches(large);
    expect(batches.every((b) => b.length <= 50 && b.reduce((n, c) => n + c.text.length, 0) <= 100_000)).toBe(true);
    expect(batches.flat().map((c) => c.seq)).toEqual(large.map((c) => c.seq));
  });
});
