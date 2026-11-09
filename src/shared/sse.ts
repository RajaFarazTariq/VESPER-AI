/**
 * Incremental parser for Server-Sent Events (text/event-stream).
 * Used by the Worker (reading provider streams) and by the browser (reading our own stream).
 * Follows the WHATWG spec closely enough for every provider we talk to:
 * `event:` / `data:` fields, multi-line data, comments (`:`) and blank-line dispatch.
 */
export interface SseEvent {
  event: string;
  data: string;
}

export class SseParser {
  private buffer = "";
  private dataLines: string[] = [];
  private eventName = "";

  /** Feed a decoded text chunk; returns every event completed by it. */
  feed(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      let line = this.buffer.slice(0, newline);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.buffer = this.buffer.slice(newline + 1);
      const event = this.processLine(line);
      if (event) events.push(event);
      newline = this.buffer.indexOf("\n");
    }
    return events;
  }

  /** Call when the stream ends to dispatch a final event that lacked a trailing blank line. */
  flush(): SseEvent[] {
    const events: SseEvent[] = [];
    if (this.buffer.length > 0) {
      const line = this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer;
      this.buffer = "";
      const event = this.processLine(line);
      if (event) events.push(event);
    }
    const last = this.dispatch();
    if (last) events.push(last);
    return events;
  }

  private processLine(line: string): SseEvent | null {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return null; // comment / keep-alive
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.dataLines.push(value);
    else if (field === "event") this.eventName = value;
    return null;
  }

  private dispatch(): SseEvent | null {
    if (this.dataLines.length === 0) {
      this.eventName = "";
      return null;
    }
    const event = { event: this.eventName || "message", data: this.dataLines.join("\n") };
    this.dataLines = [];
    this.eventName = "";
    return event;
  }
}

/** Format one SSE frame. */
export function formatSse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
