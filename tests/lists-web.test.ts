/**
 * v0.19.0, the browser side that needs nothing from the page: the "Open youtube.com" buttons, what a calendar change
 * card highlights, list headings and searches, where a restored chat goes back in the sidebar, and VESPER Agent's
 * spoken progress line for the new tools.
 */
import { describe, expect, it } from "vitest";
import type { GoogleEventPreviewDto, ToolEventDto } from "../src/shared/types";
import { progressLine } from "../src/web/lib/agent-voice";
import { eventChanges, guestChanges, insertByUpdated, listCounts, matchesSearch, websiteLink, websiteLinks } from "../src/web/lib/format";

const event = (patch: Partial<GoogleEventPreviewDto> = {}): GoogleEventPreviewDto => ({
  title: "Team sync",
  start: "2026-12-02T10:00",
  end: "2026-12-02T11:00",
  allDay: false,
  timeZone: "Asia/Karachi",
  calendarTimeZone: null,
  location: "Room 4",
  description: "Weekly catch-up",
  attendees: ["ann@example.com"],
  meet: false,
  clashes: [],
  account: "me@example.com",
  ...patch,
});

const tool = (name: string, link?: { url: string; title: string }): ToolEventDto => ({
  id: `${name}-${Math.random()}`,
  name,
  label: name,
  args: {},
  status: "done",
  summary: null,
  ...(link ? { link } : {}),
});

describe("website buttons", () => {
  it("shows the whole domain without www", () => {
    expect(websiteLink({ url: "https://www.youtube.com/", title: "YouTube" })).toEqual({ url: "https://www.youtube.com/", domain: "youtube.com", title: "YouTube" });
    expect(websiteLink({ url: "https://mail.google.com/mail/u/0/", title: "Gmail" })?.domain).toBe("mail.google.com");
    expect(websiteLink({ url: "http://example.org/page?q=1", title: "" })).toEqual({ url: "http://example.org/page?q=1", domain: "example.org", title: "example.org" });
  });

  it("shows look-alike international domains in their plain (xn--) form", () => {
    expect(websiteLink({ url: "https://аpple.com/", title: "Apple" })?.domain).toMatch(/^xn--/);
  });

  it("refuses anything that isn't a plain http(s) address", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,hi", "file:///C:/x", "ftp://example.com", "not a url", "https://user:pass@example.com/", "https://evil@example.com/"]) {
      expect(websiteLink({ url, title: "x" })).toBeNull();
    }
    expect(websiteLink(null)).toBeNull();
    expect(websiteLink({ url: 42, title: "x" })).toBeNull();
  });

  it("takes each link of a reply once, in order", () => {
    const tools = [
      tool("open_website", { url: "https://www.youtube.com/", title: "YouTube" }),
      tool("web_search"),
      tool("open_website", { url: "https://github.com/", title: "GitHub" }),
      tool("open_website", { url: "https://www.youtube.com/", title: "YouTube" }),
      tool("open_website", { url: "javascript:void(0)", title: "Bad" }),
    ];
    expect(websiteLinks(tools).map((l) => l.domain)).toEqual(["youtube.com", "github.com"]);
    expect(websiteLinks(null)).toEqual([]);
  });
});

describe("calendar change card", () => {
  it("finds only the fields that change", () => {
    expect([...eventChanges(event(), event())]).toEqual([]);
    expect([...eventChanges(event(), event({ start: "2026-12-02T14:00", end: "2026-12-02T15:00" }))]).toEqual(["when"]);
    expect([...eventChanges(event(), event({ title: "Team sync (moved)", location: "" }))].sort()).toEqual(["location", "title"]);
    expect([...eventChanges(event(), event({ description: "Weekly catch-up  " }))]).toEqual([]);
    expect([...eventChanges(event(), event({ timeZone: "Europe/London" }))]).toEqual(["when"]);
    // An all-day event's time zone doesn't move it.
    const day = { start: "2026-12-02", end: "2026-12-02", allDay: true };
    expect([...eventChanges(event(day), event({ ...day, timeZone: "Europe/London" }))]).toEqual([]);
    expect([...eventChanges(event(), event({ ...day }))]).toEqual(["when"]);
  });

  it("compares guests without case or order", () => {
    const before = event({ attendees: ["Ann@Example.com", "bob@example.com"] });
    expect([...eventChanges(before, event({ attendees: ["bob@example.com", "ann@example.com"] }))]).toEqual([]);
    expect([...eventChanges(before, event({ attendees: ["ann@example.com"] }))]).toEqual(["guests"]);
    expect(guestChanges(["Ann@Example.com", "bob@example.com"], ["ann@example.com", "cy@example.com"])).toEqual({
      added: ["cy@example.com"],
      removed: ["bob@example.com"],
    });
  });

  it("tells default reminders apart from none and from set ones", () => {
    expect([...eventChanges(event(), event({ reminders: [] }))]).toEqual(["reminders"]);
    expect([...eventChanges(event({ reminders: [{ at: "x", minutes: 10 }, { at: "y", minutes: 60 }] }), event({ reminders: [{ at: "y", minutes: 60 }, { at: "x", minutes: 10 }] }))]).toEqual([]);
    expect([...eventChanges(event({ reminders: [{ at: "x", minutes: 10 }] }), event({ reminders: [{ at: "x", minutes: 30 }] }))]).toEqual(["reminders"]);
  });
});

describe("lists, notes and archived chats", () => {
  it("sums up a list for its heading", () => {
    expect(listCounts([])).toBe("Empty");
    expect(listCounts([{ done: false }, { done: false }])).toBe("2 to do");
    expect(listCounts([{ done: true }, { done: true }])).toBe("All 2 done");
    expect(listCounts([{ done: false }, { done: true }, { done: false }])).toBe("2 to do · 1 done");
  });

  it("matches every word of a search, in any order and case", () => {
    expect(matchesSearch("The gate code is on the green card", "GREEN gate")).toBe(true);
    expect(matchesSearch("The gate code is on the green card", "gate blue")).toBe(false);
    expect(matchesSearch("anything", "   ")).toBe(true);
  });

  it("puts a restored chat back where it belongs, newest first, once", () => {
    const list = [
      { id: "a", updatedAt: 30 },
      { id: "b", updatedAt: 20 },
      { id: "c", updatedAt: 10 },
    ];
    expect(insertByUpdated(list, { id: "x", updatedAt: 25 }).map((c) => c.id)).toEqual(["a", "x", "b", "c"]);
    expect(insertByUpdated(list, { id: "x", updatedAt: 40 }).map((c) => c.id)).toEqual(["x", "a", "b", "c"]);
    expect(insertByUpdated(list, { id: "x", updatedAt: 1 }).map((c) => c.id)).toEqual(["a", "b", "c", "x"]);
    expect(insertByUpdated(list, { id: "b", updatedAt: 35 }).map((c) => c.id)).toEqual(["b", "a", "c"]);
    expect(insertByUpdated([], { id: "x", updatedAt: 1 }).map((c) => c.id)).toEqual(["x"]);
  });

  it("leaves a restored chat older than the loaded ones to 'Load older chats' when more are to load", () => {
    const list = [
      { id: "a", updatedAt: 30 },
      { id: "b", updatedAt: 20 },
    ];
    expect(insertByUpdated(list, { id: "x", updatedAt: 5 }, true).map((c) => c.id)).toEqual(["a", "b"]);
    expect(insertByUpdated(list, { id: "x", updatedAt: 25 }, true).map((c) => c.id)).toEqual(["a", "x", "b"]);
    expect(insertByUpdated(list, { id: "x", updatedAt: 5 }, false).map((c) => c.id)).toEqual(["a", "b", "x"]);
  });
});

describe("VESPER Agent's spoken progress for the new tools", () => {
  it("says what it is doing", () => {
    expect(progressLine("open_website")).toBe("Here's the link.");
    expect(progressLine("calendar_update_event")).toBe("Preparing that change.");
    expect(progressLine("calendar_delete_event")).toBe("Preparing that change.");
    expect(progressLine("lists")).toBe("Updating your list.");
    expect(progressLine("notes")).toBe("Saving that note.");
  });

  it("follows the request for lists and notes", () => {
    expect(progressLine("lists", "Add milk and eggs to my shopping list")).toBe("Updating your list.");
    expect(progressLine("lists", "Can you add eggs to my shopping list?")).toBe("Updating your list.");
    expect(progressLine("lists", "What's on my to-do list?")).toBe("Checking your list.");
    expect(progressLine("lists", "Please show my packing list")).toBe("Checking your list.");
    expect(progressLine("lists", "Remove milk")).toBe("Updating your list.");
    expect(progressLine("lists", "Clear the done items")).toBe("Updating your list.");
    expect(progressLine("notes", "Note that the gate code is on the green card")).toBe("Saving that note.");
    expect(progressLine("notes", "What did I note about the gate?")).toBe("Checking your notes.");
    expect(progressLine("notes", "Do I have any notes about the car")).toBe("Checking your notes.");
    expect(progressLine("notes", "Delete my note about the gate")).toBe("Updating your notes.");
  });

  it("follows the tool's action when it is known", () => {
    expect(progressLine("lists", "What's on my list?", { action: "add" })).toBe("Updating your list.");
    expect(progressLine("lists", "", { action: "show" })).toBe("Checking your list.");
    expect(progressLine("notes", "", { action: "search" })).toBe("Checking your notes.");
    expect(progressLine("notes", "", { action: "show_recent" })).toBe("Checking your notes.");
    expect(progressLine("notes", "", { action: "add" })).toBe("Saving that note.");
    expect(progressLine("notes", "", { action: "delete" })).toBe("Updating your notes.");
  });
});
