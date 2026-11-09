#!/usr/bin/env node
/**
 * Offline mock of OpenAI-compatible LLM APIs, for developing and testing without API keys.
 *
 *   npm run mock:llm                  # listens on http://127.0.0.1:8790
 *   MOCK_FAIL=groq npm run mock:llm   # make "groq" answer 429 to exercise automatic fallback
 *
 * Point a provider at it with e.g. GROQ_BASE_URL=http://127.0.0.1:8790/groq and GROQ_API_KEY=mock.
 */
import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_PORT ?? 8790);
const failing = new Set((process.env.MOCK_FAIL ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

const server = createServer(async (req, res) => {
  const [, provider = "mock", ...rest] = (req.url ?? "/").split("?")[0].split("/");
  const path = "/" + rest.join("/");

  if (req.method === "GET" && path === "/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: `${provider}-mock-large`, context_window: 131072 }, { id: `${provider}-mock-small`, context_window: 32768 }] }));
    return;
  }

  if (req.method === "POST" && path === "/chat/completions") {
    const body = JSON.parse((await readBody(req)) || "{}");
    if (failing.has(provider)) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "20" });
      res.end(JSON.stringify({ error: { message: `Rate limit reached for ${body.model} (mock)` } }));
      return;
    }
    const last = [...(body.messages ?? [])].reverse().find((m) => m.role === "user")?.content ?? "";
    const reply =
      `**Mock reply** from \`${provider}\` (model \`${body.model}\`).\n\n` +
      `You said: "${String(last).slice(0, 200)}"\n\n` +
      "Here is a code sample:\n\n```python\ndef greet(name: str) -> str:\n    return f\"Hello, {name}!\"\n```\n\n" +
      "| Item | Value |\n|---|---|\n| Messages in context | " + (body.messages?.length ?? 0) + " |\n";
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    for (const piece of reply.match(/\S+\s*|\s+/g) ?? []) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
      await sleep(15);
    }
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 42, completion_tokens: 64 } })}\n\n`);
    res.end("data: [DONE]\n\n");
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: "not found" } }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Mock LLM server on http://127.0.0.1:${PORT}  (failing: ${[...failing].join(", ") || "none"})`);
});
