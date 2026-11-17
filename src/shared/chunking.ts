/**
 * Splitting extracted document text into passages ("chunks") for the knowledge base.
 * Shared by the browser (uploaded files) and the Worker (web pages).
 *
 * A document is first cut into units that each have one location: a PDF page, a Markdown/Word
 * section, a block of CSV rows. Each unit is then packed into passages of about CHUNK_TARGET_CHARS
 * (roughly a third of a page) along line and sentence boundaries, with a small overlap so a fact
 * that straddles two passages is still found. Passages never cross units, so every passage can be
 * cited with a single location ("page 12").
 */
import type { KnowledgeChunkInput } from "./types";

export const CHUNK_TARGET_CHARS = 1_200;
export const CHUNK_MAX_CHARS = 1_800;
const CHUNK_OVERLAP_CHARS = 200;
const CHUNK_MIN_CHARS = 200;
/** Server-side cap per passage; chunkUnits never produces more than about 2,000. */
export const CHUNK_HARD_LIMIT = 4_000;

/** A piece of a document with one location. */
export interface TextUnit {
  location: string;
  text: string;
}

/** Tidy extracted text: line endings, soft hyphens, words hyphenated across lines, runs of spaces. */
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/­/g, "")
    .replace(/([A-Za-z])-\n([a-z])/g, "$1$2")
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Lines, with over-long lines split into sentences and over-long sentences cut at spaces. */
function segments(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.length <= CHUNK_MAX_CHARS) {
      out.push(line);
      continue;
    }
    const sentences = line.match(/[^.!?。؟]+(?:[.!?。؟]+["'”’)\]]*\s*|$)/g) ?? [line];
    for (const sentence of sentences) {
      let rest = sentence.trim();
      while (rest.length > CHUNK_MAX_CHARS) {
        let cut = rest.lastIndexOf(" ", CHUNK_TARGET_CHARS);
        if (cut < CHUNK_TARGET_CHARS / 2) cut = CHUNK_TARGET_CHARS;
        out.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      if (rest) out.push(rest);
    }
  }
  return out;
}

/** The last few segments of a passage (up to CHUNK_OVERLAP_CHARS), repeated at the start of the next. */
function overlapOf(parts: string[]): string[] {
  const carry: string[] = [];
  let size = 0;
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]!;
    if (size + part.length > CHUNK_OVERLAP_CHARS) break;
    carry.unshift(part);
    size += part.length + 1;
  }
  return carry;
}

/** Pack units into numbered passages (seq starts at `startSeq`). Empty units produce nothing. */
export function chunkUnits(units: TextUnit[], startSeq = 0): KnowledgeChunkInput[] {
  const chunks: KnowledgeChunkInput[] = [];
  let seq = startSeq;
  for (const unit of units) {
    const location = unit.location.trim().slice(0, 120);
    const segs = segments(normalizeText(unit.text));
    let parts: string[] = [];
    let size = 0;
    let fresh = 0; // segments in `parts` that aren't overlap from the previous passage
    let unitChunks = 0;

    const emit = () => {
      chunks.push({ seq: seq++, location, text: parts.join("\n") });
      unitChunks++;
      parts = overlapOf(parts);
      size = parts.reduce((n, p) => n + p.length + 1, 0);
      fresh = 0;
    };

    for (const seg of segs) {
      if (fresh > 0 && size + seg.length > CHUNK_TARGET_CHARS) emit();
      parts.push(seg);
      size += seg.length + 1;
      fresh++;
    }
    if (fresh === 0) continue;
    const tail = parts.slice(parts.length - fresh);
    const last = chunks[chunks.length - 1];
    const tailSize = tail.reduce((n, p) => n + p.length + 1, 0);
    if (unitChunks > 0 && last && tailSize < CHUNK_MIN_CHARS && last.text.length + tailSize <= CHUNK_MAX_CHARS) {
      last.text = `${last.text}\n${tail.join("\n")}`; // a short remainder joins the previous passage
    } else {
      emit();
    }
  }
  return chunks;
}

/** Markdown (and Word converted to Markdown-like text): one unit per heading, cited as its section. */
export function markdownUnits(text: string): TextUnit[] {
  const units: TextUnit[] = [];
  let location = "";
  let lines: string[] = [];
  const flush = () => {
    const body = lines.join("\n").trim();
    if (body) units.push({ location, text: body });
    lines = [];
  };
  for (const line of normalizeText(text).split("\n")) {
    const heading = /^#{1,6}\s+(.+?)\s*#*$/.exec(line);
    if (heading) {
      flush();
      const title = heading[1]!.replace(/[*_`]/g, "").trim();
      location = title ? `section “${title.slice(0, 80)}”` : "";
    }
    lines.push(line);
  }
  flush();
  return units;
}

/** Split CSV text into records, honouring quoted fields that contain commas or line breaks. */
export function csvRecords(text: string): string[] {
  const records: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') quoted = !quoted;
    if (!quoted && (ch === "\n" || ch === "\r")) {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      if (current.trim()) records.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) records.push(current);
  return records;
}

/**
 * CSV: blocks of rows that each repeat the header line, so every passage is self-describing.
 * Locations use spreadsheet row numbers (the header is row 1).
 */
export function csvUnits(text: string): TextUnit[] {
  const records = csvRecords(text.replace(/^﻿/, ""));
  const header = records[0];
  if (!header) return [];
  const units: TextUnit[] = [];
  let rows: string[] = [];
  let first = 2;
  let size = header.length;
  const flush = (lastRow: number) => {
    if (rows.length === 0) return;
    units.push({ location: first === lastRow ? `row ${first}` : `rows ${first}–${lastRow}`, text: [header, ...rows].join("\n") });
    rows = [];
    size = header.length;
  };
  for (let i = 1; i < records.length; i++) {
    const record = records[i]!;
    if (rows.length > 0 && size + record.length + 1 > CHUNK_TARGET_CHARS) {
      flush(i);
      first = i + 1;
    }
    rows.push(record);
    size += record.length + 1;
  }
  flush(records.length);
  return units;
}
