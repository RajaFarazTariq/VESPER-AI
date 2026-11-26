/**
 * Lists and notes (v0.19.0): "add milk and eggs to my shopping list", "what's on my to-do list?", "mark 'call Ali'
 * done", "note that the gate code is on the green card", "what did I note about the gate?". Like memory and
 * reminders, these tools only change the user's own VESPER data, so no approval card is needed. Two tools with an
 * action each (instead of one per action) keep the tool list sent with every model request small.
 *
 * Notes and list items refuse passwords, card/bank numbers, ID card numbers and phone numbers, exactly like memory.
 */
import { z } from "zod";
import type { ListItemDto } from "../../shared/types";
import {
  addItems,
  addNote,
  cleanNote,
  clearDone,
  DEFAULT_LIST,
  deleteList,
  deleteNote,
  ensureList,
  findList,
  listItems,
  listName,
  listNotes,
  listSummaries,
  MAX_ITEM_CHARS,
  MAX_ITEMS,
  MAX_LIST_NAME,
  MAX_LISTS,
  MAX_NOTE_CHARS,
  MAX_NOTES,
  noteWords,
  oneLine,
  removeItems,
  renameList,
  searchNotes,
  setItemsDone,
  type ListRow,
} from "../db/lists";
import { sensitiveMessage, sensitiveReason } from "../lib/sensitive";
import { dayLabel, validTimeZone, wallClock } from "./google";
import { clip } from "./net";
import { define, ToolInputError, type AgentTool, type ToolContext, type ToolOutput } from "./types";

export const LIST_TOOL_NAMES = new Set(["lists", "notes"]);
/** Characters of item or note text one result may carry (a tool result is cut at 8,000). */
const RESULT_TEXT_CHARS = 5_000;
const NOTES_PER_RESULT = 10;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function nameOf(raw: string | undefined): { name: string; key: string } {
  // "" (a filled-in optional field) is the default list too.
  const name = listName(raw?.trim() ? raw : DEFAULT_LIST);
  if (!name) throw new ToolInputError("Give the list a name.");
  if (name.name.length > MAX_LIST_NAME) throw new ToolInputError(`Keep a list name under ${MAX_LIST_NAME} characters.`);
  return name;
}

/** Item texts from the model: one line each, not empty, not too long. */
function itemTexts(items: string | string[] | undefined, action: string): string[] {
  const texts = (Array.isArray(items) ? items : items ? [items] : []).map(oneLine).filter(Boolean);
  if (texts.length === 0) throw new ToolInputError(`Give the items to ${action === "add" ? "add" : action === "remove" ? "remove" : "mark"} (items).`);
  const long = texts.find((t) => t.length > MAX_ITEM_CHARS);
  if (long) throw new ToolInputError(`Keep each item under ${MAX_ITEM_CHARS} characters ("${clip(long, 40)}" is longer).`);
  return texts;
}

/** What the model sees of a list: the open and done items (as many as fit), and the counts. */
function listView(list: ListRow, items: ListItemDto[]) {
  let budget = RESULT_TEXT_CHARS;
  const take = (all: ListItemDto[]) => {
    const shown: string[] = [];
    for (const item of all) {
      if (budget - item.text.length < 0) break;
      budget -= item.text.length;
      shown.push(item.text);
    }
    return shown;
  };
  const open = items.filter((i) => !i.done);
  const done = items.filter((i) => i.done);
  const openShown = take(open);
  const doneShown = take(done);
  const hidden = open.length - openShown.length + done.length - doneShown.length;
  return {
    list: list.name,
    open: openShown,
    ...(done.length ? { done: doneShown } : {}),
    ...(hidden > 0 ? { not_shown: hidden } : {}),
  };
}

const NORMALISE_QUOTES = /^["'“”‘’]+|["'“”‘’]+$/g;

/**
 * The item a text means: the one with exactly that text (any case), else the only one containing it (3+ characters;
 * "remove oat milk" never removes "Milk"). Items in the preferred state come first (marking done looks at open items,
 * undo at done ones). A string when there's no clear match: empty text and bare numbers match nothing.
 */
function matchItem(items: ListItemDto[], wanted: string, prefer?: (i: ListItemDto) => boolean): ListItemDto | string {
  const w = oneLine(wanted).replace(NORMALISE_QUOTES, "").trim().toLowerCase();
  if (!w) return "An empty item matches nothing: say the item's words.";
  const pool = prefer && items.some(prefer) ? [...items.filter(prefer), ...items.filter((i) => !prefer(i))] : items;
  const exact = pool.find((i) => i.text.toLowerCase() === w);
  if (exact) return exact;
  if (/^\d+$/.test(w)) return `"${w}" isn't an item's text: say the item's words.`;
  const partial = w.length >= 3 ? pool.filter((i) => i.text.toLowerCase().includes(w)) : [];
  const preferred = prefer ? partial.filter(prefer) : partial;
  const pick = preferred.length === 1 ? preferred : partial;
  if (pick.length === 1) return pick[0]!;
  if (pick.length > 1) return `"${clip(wanted, 60)}" matches several items (${pick.slice(0, 5).map((i) => `"${clip(i.text, 60)}"`).join(", ")}): ask which one.`;
  return `"${clip(wanted, 60)}" isn't on the list.`;
}

async function existing(ctx: ToolContext, name: { name: string; key: string }): Promise<ListRow> {
  const list = await findList(ctx.db, ctx.userId, name.key);
  if (list) return list;
  const others = (await listSummaries(ctx.db, ctx.userId)).map((l) => l.name);
  throw new ToolInputError(`There is no "${name.name}" list.${others.length ? ` The user's lists: ${others.join(", ")}.` : " The user has no lists yet."}`);
}

const LIST_ACTIONS = ["add", "show", "done", "undo", "remove", "clear_done", "rename", "delete_list"] as const;

const lists = define({
  name: "lists",
  label: "Lists",
  description:
    'The user\'s lists (to-do, shopping…). list defaults to "To-do"; add creates it. done/undo/remove take item texts.',
  risk: "write",
  requiresMemory: false,
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: [...LIST_ACTIONS] },
      list: { type: "string" },
      items: { type: "array", items: { type: "string" } },
      new_name: { type: "string" },
    },
    required: ["action"],
  },
  schema: z.object({
    action: z.enum(LIST_ACTIONS),
    list: z.string().max(100).optional(),
    items: z.union([z.array(z.string().max(1_000)).max(50), z.string().max(2_000)]).optional(),
    new_name: z.string().max(100).optional(),
  }),
  async run(args, ctx): Promise<ToolOutput> {
    const name = nameOf(args.list);
    const now = ctx.now.getTime();

    if (args.action === "add") {
      const texts = itemTexts(args.items, "add");
      // Like memory and notes: passwords and card/bank/ID/phone numbers are never kept.
      for (const text of texts) {
        const reason = sensitiveReason(text);
        if (reason) throw new ToolInputError(`${sensitiveMessage(reason)} Tell the user nothing was added and why.`);
      }
      const list = await ensureList(ctx.db, ctx.userId, name, now);
      if (list === "full") throw new ToolInputError(`The user already has ${MAX_LISTS} lists, the most VESPER keeps. Ask them to delete one first (Settings → Lists & notes).`);
      const result = await addItems(ctx.db, ctx.userId, list.id, texts, now);
      const view = listView(list, await listItems(ctx.db, list.id));
      return {
        content: JSON.stringify({
          added: result.added,
          ...(result.already.length ? { already_on_the_list: result.already } : {}),
          ...(result.full.length ? { not_added_list_full: result.full, note: `A list holds at most ${MAX_ITEMS} items.` } : {}),
          ...view,
        }),
        summary: `Added ${plural(result.added.length, "item")} to ${list.name}${result.already.length ? ` (${result.already.length} already there)` : ""}`,
      };
    }

    if (args.action === "show") {
      const list = await findList(ctx.db, ctx.userId, name.key);
      // Without a list name: the To-do list and the names of the others ("what lists do I have?").
      const others = args.list?.trim() ? [] : (await listSummaries(ctx.db, ctx.userId)).filter((l) => l.name !== list?.name);
      const extra = others.length ? { other_lists: others.map((l) => ({ name: l.name, open: l.open })) } : {};
      if (!list) {
        return {
          content: JSON.stringify({ list: name.name, exists: false, note: `There is no ${name.name} list yet.`, ...extra }),
          summary: `No ${name.name} list yet`,
        };
      }
      const items = await listItems(ctx.db, list.id);
      const open = items.filter((i) => !i.done).length;
      return {
        content: JSON.stringify({ ...listView(list, items), ...extra }),
        summary: `${list.name}: ${open} open${items.length > open ? `, ${items.length - open} done` : ""}`,
      };
    }

    const list = await existing(ctx, name);

    if (args.action === "done" || args.action === "undo" || args.action === "remove") {
      const texts = itemTexts(args.items, args.action);
      const items = await listItems(ctx.db, list.id);
      const prefer = args.action === "done" ? (i: ListItemDto) => !i.done : args.action === "undo" ? (i: ListItemDto) => i.done : undefined;
      const ids = new Set<string>();
      const problems: string[] = [];
      for (const text of texts) {
        const found = matchItem(items, text, prefer);
        if (typeof found === "string") problems.push(found);
        else ids.add(found.id);
      }
      if (ids.size === 0) {
        throw new ToolInputError(`${problems.join(" ")} The ${list.name} list has: ${items.map((i) => `"${clip(i.text, 60)}"${i.done ? " (done)" : ""}`).join(", ") || "nothing"}.`);
      }
      const changed =
        args.action === "remove"
          ? await removeItems(ctx.db, ctx.userId, list.id, [...ids], now)
          : await setItemsDone(ctx.db, ctx.userId, list.id, [...ids], args.action === "done", now);
      const verb = args.action === "remove" ? "Removed" : args.action === "done" ? "Marked done" : "Marked not done";
      return {
        content: JSON.stringify({
          [args.action === "remove" ? "removed" : args.action === "done" ? "marked_done" : "marked_not_done"]: items.filter((i) => ids.has(i.id)).map((i) => i.text),
          ...(problems.length ? { not_changed: problems } : {}),
          ...listView(list, await listItems(ctx.db, list.id)),
        }),
        summary: `${verb}: ${plural(changed, "item")} on ${list.name}`,
      };
    }

    if (args.action === "clear_done") {
      const removed = await clearDone(ctx.db, ctx.userId, list.id, now);
      return {
        content: JSON.stringify({ removed_done_items: removed, ...listView(list, await listItems(ctx.db, list.id)) }),
        summary: `Cleared ${plural(removed, "done item")} from ${list.name}`,
      };
    }

    if (args.action === "rename") {
      if (!args.new_name?.trim()) throw new ToolInputError("Give the new name (new_name).");
      const renamed = await renameList(ctx.db, ctx.userId, list.id, nameOf(args.new_name), now);
      if (renamed === "taken") throw new ToolInputError(`There is already a list called "${nameOf(args.new_name).name}".`);
      if (!renamed) throw new ToolInputError(`There is no "${name.name}" list.`);
      return { content: JSON.stringify({ renamed: true, from: list.name, to: renamed.name }), summary: `Renamed ${list.name} to ${renamed.name}` };
    }

    // delete_list
    const items = await listItems(ctx.db, list.id);
    await deleteList(ctx.db, ctx.userId, list.id);
    return {
      content: JSON.stringify({ deleted_list: list.name, items_deleted: items.length }),
      summary: `Deleted the ${list.name} list (${plural(items.length, "item")})`,
    };
  },
});

const NOTE_ACTIONS = ["add", "search", "show_recent", "delete"] as const;

/** Notes as the model sees them: id, the day saved and the text, as many as fit. */
function noteView(notes: { id: string; text: string; createdAt: number }[], timeZone: string) {
  let budget = RESULT_TEXT_CHARS;
  const shown: { id: string; saved: string; text: string }[] = [];
  for (const n of notes) {
    if (budget <= 0) break;
    const text = n.text.length <= budget ? n.text : clip(n.text, Math.max(200, budget));
    budget -= text.length;
    shown.push({ id: n.id, saved: dayLabel(wallClock(n.createdAt, timeZone).date), text });
  }
  return shown;
}

const notes = define({
  name: "notes",
  label: "Notes",
  description:
    'Notes the user asks VESPER to keep ("note that…") and look up later. Passwords and card/bank/ID/phone numbers are refused.',
  risk: "write",
  requiresMemory: false,
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: [...NOTE_ACTIONS] },
      text: { type: "string" },
      query: { type: "string", description: "Key words." },
      id: { type: "string" },
    },
    required: ["action"],
  },
  schema: z.object({
    action: z.enum(NOTE_ACTIONS),
    text: z.string().max(MAX_NOTE_CHARS * 2).optional(),
    query: z.string().max(300).optional(),
    id: z.string().trim().max(64).optional(),
  }),
  async run(args, ctx): Promise<ToolOutput> {
    const timeZone = validTimeZone(ctx.timeZone) ?? "UTC";
    if (args.action === "add") {
      const text = cleanNote(args.text ?? "");
      if (!text) throw new ToolInputError("Give the note's text.");
      if (text.length > MAX_NOTE_CHARS) throw new ToolInputError(`A note can be at most ${MAX_NOTE_CHARS.toLocaleString("en-US")} characters.`);
      // Exactly like memory: these are never kept, and the user is told why.
      const reason = sensitiveReason(text);
      if (reason) throw new ToolInputError(`${sensitiveMessage(reason)} Tell the user this was not saved and why.`);
      const note = await addNote(ctx.db, ctx.userId, text, ctx.now.getTime());
      if (note === "full") throw new ToolInputError(`The user has ${MAX_NOTES} notes, the most VESPER keeps. Ask them to delete some in Settings → Lists & notes.`);
      return { content: JSON.stringify({ saved: true, id: note.id }), summary: `Noted: ${clip(note.text, 80)}` };
    }
    if (args.action === "search") {
      const words = noteWords(args.query ?? "");
      if (words.length === 0) throw new ToolInputError("Give a few key words to search for (query), or use show_recent.");
      const found = await searchNotes(ctx.db, ctx.userId, words, NOTES_PER_RESULT);
      return {
        content: JSON.stringify({ searched_for: words, notes: noteView(found, timeZone), ...(found.length ? {} : { note: "No saved note contains these words." }) }),
        summary: `${plural(found.length, "note")} about "${clip(args.query ?? "", 40)}"`,
      };
    }
    if (args.action === "show_recent") {
      const recent = await listNotes(ctx.db, ctx.userId, NOTES_PER_RESULT);
      return {
        content: JSON.stringify({ notes: noteView(recent, timeZone), ...(recent.length ? {} : { note: "No notes saved yet." }) }),
        summary: `${plural(recent.length, "recent note")}`,
      };
    }
    if (!args.id) throw new ToolInputError("Give the note's id (from search or show_recent).");
    const deleted = await deleteNote(ctx.db, ctx.userId, args.id);
    if (!deleted) throw new ToolInputError(`No note with id "${clip(args.id, 64)}". Use search or show_recent to see the ids.`);
    return { content: JSON.stringify({ deleted: true, text: clip(deleted.text, 200) }), summary: `Deleted the note "${clip(deleted.text, 60)}"` };
  },
});

export const LIST_TOOLS: AgentTool[] = [lists, notes];
