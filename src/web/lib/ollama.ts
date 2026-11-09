/**
 * Optional local models through Ollama (https://ollama.com), called directly from the browser.
 * The cloud server never contacts your computer. Ollama must allow this site's origin:
 *   OLLAMA_ORIGINS=https://<your-app>.workers.dev ollama serve
 */

export interface OllamaModel {
  name: string;
  size: number;
}

const trimUrl = (url: string) => url.replace(/\/+$/, "");

export async function listOllamaModels(baseUrl: string, signal?: AbortSignal): Promise<OllamaModel[]> {
  const response = await fetch(`${trimUrl(baseUrl)}/api/tags`, { signal });
  if (!response.ok) throw new Error(`Ollama responded with ${response.status}`);
  const json = (await response.json()) as { models?: { name: string; size: number }[] };
  return (json.models ?? []).map((m) => ({ name: m.name, size: m.size }));
}

export function explainOllamaError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/Failed to fetch|NetworkError|Load failed/i.test(message)) {
    return (
      "Couldn't reach Ollama. Make sure it is running on this computer and allows this site: " +
      `set OLLAMA_ORIGINS=${window.location.origin} before starting \`ollama serve\`. ` +
      "Your browser may also ask for permission to access devices on your local network."
    );
  }
  return `Ollama error: ${message}`;
}

/** Stream a chat completion from Ollama's /api/chat (newline-delimited JSON). */
export async function streamOllamaChat(
  baseUrl: string,
  model: string,
  messages: { role: string; content: string }[],
  onText: (text: string) => void,
  onReasoning: (text: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(`${trimUrl(baseUrl)}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, stream: true }),
    signal,
  });
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    throw new Error(text.slice(0, 300) || `HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const handle = (line: string) => {
    if (!line.trim()) return;
    const json = JSON.parse(line) as { message?: { content?: string; thinking?: string }; error?: string };
    if (json.error) throw new Error(json.error);
    if (json.message?.thinking) onReasoning(json.message.thinking);
    if (json.message?.content) onText(json.message.content);
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      handle(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  }
  handle(buffer + decoder.decode());
}
