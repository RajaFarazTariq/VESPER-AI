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

function pickTool(text, names) {
  const time = /time in ([A-Za-z_]+\/[A-Za-z_]+)/i.exec(text);
  if (time && names.includes("current_datetime")) return { name: "current_datetime", args: { timezone: time[1] } };
  const remember = /remember (?:that )?(.+)/i.exec(text);
  if (remember && names.includes("remember")) return { name: "remember", args: { fact: remember[1].trim() } };
  const calc = /(?:calculate|compute|what is)\s+([-+*/^%().\d\s!a-z,]+?)\??$/i.exec(text);
  if (calc && names.includes("calculator")) return { name: "calculator", args: { expression: calc[1].trim() } };
  return null;
}

async function streamText(res, text) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const piece of text.match(/\S+\s*|\s+/g) ?? []) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
    await sleep(15);
  }
  res.end("data: [DONE]\n\n");
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
    const lastMessage = (body.messages ?? []).at(-1);
    const last = [...(body.messages ?? [])].reverse().find((m) => m.role === "user")?.content ?? "";

    // Tool calling: decide on a tool for recognisable requests, then answer from the tool result.
    if (Array.isArray(body.tools) && body.tools.length > 0) {
      const toolNames = body.tools.map((t) => t.function?.name);
      if (lastMessage?.role === "tool") {
        return streamText(res, `Done. The tool returned: ${lastMessage.content}`);
      }
      const call = pickTool(String(last), toolNames);
      if (call) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const args = JSON.stringify(call.args);
        const half = Math.ceil(args.length / 2);
        // Stream the call in two fragments, like real providers do.
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_mock1", type: "function", function: { name: call.name, arguments: args.slice(0, half) } }] } }] })}\n\n`);
        await sleep(15);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(half) } }] }, finish_reason: "tool_calls" }] })}\n\n`);
        res.end("data: [DONE]\n\n");
        return;
      }
    }
    const reply =
      `**Mock reply** from \`${provider}\` (model \`${body.model}\`).\n\n` +
      `You said: "${String(last).slice(0, 200)}"\n\n` +
      "Here is a code sample:\n\n```python\ndef greet(name: str) -> str:\n    return f\"Hello, {name}!\"\n```\n\n" +
      "Math check: \\[ 2{,}340 \\times 0.175 = 409.5 \\] and inline \\(a^2 + b^2 = c^2\\), costing $409.50.\n\n" +
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
