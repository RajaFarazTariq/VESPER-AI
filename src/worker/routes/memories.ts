import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app-env";
import { addMemory, deleteAllMemories, deleteMemory, listMemories, MAX_MEMORY_CHARS, MemoryLimitError } from "../db/memories";
import { AppError, notFound } from "../lib/errors";
import { parseJson } from "../lib/validation";
import { requireUser } from "../middleware/auth";
import { toolInfo } from "../tools/registry";

export const memoryRoutes = new Hono<AppEnv>()
  .use(requireUser)

  .get("/", async (c) => c.json({ memories: await listMemories(c.env.DB, c.get("user").id) }))

  .post("/", async (c) => {
    const { content } = await parseJson(c, z.object({ content: z.string().trim().min(1).max(MAX_MEMORY_CHARS) }));
    try {
      const memory = await addMemory(c.env.DB, c.get("user").id, content, "user");
      return c.json({ memory }, 201);
    } catch (error) {
      if (error instanceof MemoryLimitError) throw new AppError(409, "memory_full", error.message);
      throw error;
    }
  })

  .delete("/:id", async (c) => {
    const deleted = await deleteMemory(c.env.DB, c.get("user").id, c.req.param("id"));
    if (!deleted) throw notFound("Memory");
    return c.json({ ok: true });
  })

  .delete("/", async (c) => c.json({ deleted: await deleteAllMemories(c.env.DB, c.get("user").id) }));

export const toolRoutes = new Hono<AppEnv>().use(requireUser).get("/", (c) => c.json({ tools: toolInfo() }));
