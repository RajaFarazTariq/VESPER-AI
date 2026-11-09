import { SseParser, type SseEvent } from "../../shared/sse";
import { ProviderError } from "./types";

/** Time allowed for a provider to start responding (headers). */
export const FIRST_BYTE_TIMEOUT_MS = 45_000;
/** Max silence between streamed chunks before we give up. */
export const IDLE_TIMEOUT_MS = 60_000;

/** An AbortController that also aborts when `parent` aborts. */
export function linkedController(parent: AbortSignal): { controller: AbortController; unlink: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent.reason);
  if (parent.aborted) controller.abort(parent.reason);
  else parent.addEventListener("abort", onAbort, { once: true });
  return { controller, unlink: () => parent.removeEventListener("abort", onAbort) };
}

/**
 * fetch() with a first-byte timeout. Distinguishes caller aborts from timeouts.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  providerLabel: string,
  timeoutMs = FIRST_BYTE_TIMEOUT_MS,
): Promise<{ response: Response; controller: AbortController; unlink: () => void }> {
  const { controller, unlink } = linkedController(signal);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return { response, controller, unlink };
  } catch (error) {
    unlink();
    if (signal.aborted) throw new ProviderError("aborted", `${providerLabel}: request aborted`);
    if (timedOut) throw new ProviderError("timeout", `${providerLabel}: no response after ${timeoutMs / 1000}s`);
    const message = error instanceof Error ? error.message : String(error);
    throw new ProviderError("network", `${providerLabel}: ${message.slice(0, 200)}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read an SSE body, yielding events. Enforces an idle timeout and stops cleanly on abort.
 */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  providerLabel: string,
  idleTimeoutMs = IDLE_TIMEOUT_MS,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  try {
    while (true) {
      if (signal.aborted) throw new ProviderError("aborted", `${providerLabel}: request aborted`);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ProviderError("timeout", `${providerLabel}: stream stalled for ${idleTimeoutMs / 1000}s`)),
          idleTimeoutMs,
        );
      });
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await Promise.race([reader.read(), timeout]);
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        if (signal.aborted) throw new ProviderError("aborted", `${providerLabel}: request aborted`);
        const message = error instanceof Error ? error.message : String(error);
        throw new ProviderError("network", `${providerLabel}: stream interrupted (${message.slice(0, 200)})`);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      if (result.done) break;
      for (const event of parser.feed(decoder.decode(result.value, { stream: true }))) yield event;
    }
    for (const event of parser.feed(decoder.decode())) yield event;
    for (const event of parser.flush()) yield event;
  } finally {
    reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
