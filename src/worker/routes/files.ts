/**
 * Spreadsheets in chat (v0.14.0): adding a file. The browser reads the file and sends:
 *   POST   /api/files                 → the overview of each sheet; counts today's limit (returns ids)
 *   POST   /api/files/:id/chunks      → blocks of rows for one sheet (up to 200 KB each; safe to send again)
 *   POST   /api/files/:id/complete    → ready to be sent with a message
 *   DELETE /api/files/:id             → remove a file that wasn't sent (gives back today's count)
 * Sending the message (POST /api/chat with `files`) links the file to the chat.
 */
import { Hono } from "hono";
import { z } from "zod";
import { TABLE_FILE_KINDS, TABLE_LIMITS } from "../../shared/tables";
import type { AppSettingsDto, TableFileKind } from "../../shared/types";
import type { AppEnv } from "../app-env";
import { getAppSettings } from "../db/app-settings";
import { utcDay } from "../db/provider-state";
import { addTableChunks, completeTableFile, createTableFile, deleteUnsentTableFile, TableError } from "../db/tables";
import { consumeDailyTable, refundDailyTable } from "../db/users";
import { getConfig } from "../env";
import { AppError, notFound } from "../lib/errors";
import { parseJson } from "../lib/validation";
import { requireUser } from "../middleware/auth";
import { rateLimit } from "../middleware/security";
import { TABLE_TOOL } from "../tools/tables";

/** Spreadsheets are on: the admin's switch, and the Table analysis tool isn't switched off for everyone. */
export const tablesAllowed = (settings: AppSettingsDto) => settings.tablesEnabled && !settings.disabledTools.includes(TABLE_TOOL);

/** A block of rows can't be bigger than this as JSON (the browser keeps blocks under 200,000 bytes). */
const CHUNK_BODY_LIMIT = 240 * 1024;
/** The overview of up to 10 sheets × 100 columns with their common values and example rows. */
const CREATE_BODY_LIMIT = 512 * 1024;

const cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const columnSchema = z.object({
  name: z.string().trim().min(1).max(200),
  type: z.enum(["number", "date", "text", "boolean"]),
  blanks: z.number().int().min(0),
  distinct: z.number().int().min(0),
  min: z.union([z.number(), z.string().max(40)]).optional(),
  max: z.union([z.number(), z.string().max(40)]).optional(),
  unit: z.string().max(8).optional(),
  hasTime: z.boolean().optional(),
  dateOrder: z.enum(["dmy", "mdy"]).optional(),
  top: z.array(z.object({ value: z.string().max(200), count: z.number().int().min(0) })).max(12).optional(),
  examples: z.array(z.string().max(200)).max(5).optional(),
  invalid: z.number().int().min(0).optional(),
});
const sheetSchema = z.object({
  sheet: z.string().trim().min(1).max(100).nullable(),
  rows: z.number().int().min(1).max(TABLE_LIMITS.rows),
  firstRow: z.number().int().min(1),
  lastRow: z.number().int().min(1),
  columns: z.array(columnSchema).min(1).max(TABLE_LIMITS.columns),
  notes: z.array(z.string().max(400)).max(10),
  samples: z.array(z.array(cell.refine((v) => typeof v !== "string" || v.length <= 200)).max(TABLE_LIMITS.columns)).max(3),
  chunks: z.number().int().min(1).max(TABLE_LIMITS.rows),
});
const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  kind: z.enum(TABLE_FILE_KINDS as [TableFileKind, ...TableFileKind[]]),
  bytes: z.number().int().min(1).max(TABLE_LIMITS.fileBytes, "The file is larger than 10 MB."),
  tables: z.array(sheetSchema).min(1).max(TABLE_LIMITS.sheets),
});
// The rows themselves are checked cell by cell in db/tables.ts (faster than a schema for thousands of cells).
const chunksSchema = z.object({
  table: z.uuid(),
  chunks: z
    .array(z.object({ seq: z.number().int().min(0), rows: z.array(z.array(z.unknown())) }))
    .min(1)
    .max(10),
});

/** Turn storage errors into API errors with plain messages. */
async function run<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof TableError)) throw error;
    const status = { not_found: 404, invalid: 400, conflict: 409, limit: 409, full: 507 }[error.code] as 400 | 404 | 409 | 507;
    throw new AppError(status, error.code === "invalid" ? "bad_request" : `table_${error.code}`, error.message);
  }
}

const uploadLimiter = rateLimit("files", 240, 60_000, (c) => c.get("user").id);

export const fileRoutes = new Hono<AppEnv>()
  .use(requireUser)

  .post("/", uploadLimiter, async (c) => {
    const user = c.get("user");
    const body = await parseJson(c, createSchema, CREATE_BODY_LIMIT);
    const settings = await getAppSettings(c.env.DB, getConfig(c.env));
    if (!tablesAllowed(settings)) throw new AppError(403, "tables_off", "Spreadsheets are switched off.");
    // Admins are counted (usage view) but never limited.
    const perDay = user.role === "admin" ? Number.MAX_SAFE_INTEGER : settings.tablesPerDay;
    if (!(await consumeDailyTable(c.env.DB, user.id, perDay))) {
      throw new AppError(
        429,
        "table_limit",
        perDay <= 0
          ? "Adding spreadsheets is paused for your account."
          : `You've added ${perDay} spreadsheets today, the daily limit. It resets at 00:00 UTC.`,
      );
    }
    const day = utcDay();
    try {
      const file = await run(() => createTableFile(c.env.DB, user.id, body));
      return c.json({ file }, 201);
    } catch (error) {
      await refundDailyTable(c.env.DB, user.id, day).catch(() => {});
      throw error;
    }
  })

  .post("/:id/chunks", uploadLimiter, async (c) => {
    const body = await parseJson(c, chunksSchema, CHUNK_BODY_LIMIT);
    const result = await run(() => addTableChunks(c.env.DB, c.get("user").id, c.req.param("id"), body.table, body.chunks as never));
    return c.json(result);
  })

  .post("/:id/complete", async (c) => c.json({ file: await run(() => completeTableFile(c.env.DB, c.get("user").id, c.req.param("id"))) }))

  .delete("/:id", async (c) => {
    const user = c.get("user");
    const removed = await deleteUnsentTableFile(c.env.DB, user.id, c.req.param("id"));
    if (!removed) throw notFound("Spreadsheet");
    // Added and removed the same day: it doesn't count.
    const day = utcDay(removed.createdAt);
    if (day === utcDay()) await refundDailyTable(c.env.DB, user.id, day);
    return c.json({ ok: true });
  });
