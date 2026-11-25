/**
 * Proactive VESPER (v0.18.0), the browser side that needs nothing from the page: the device names in the list, the
 * server's key for subscribing, the briefing time and reminder times, the test's result line, how a notification's
 * link opens VESPER Agent, and the agent's spoken progress line per tool.
 */
import { describe, expect, it } from "vitest";
import { agentLink, briefingDayOf, briefingRequest, progressLine } from "../src/web/lib/agent-voice";
import { base64UrlToBytes, bytesToBase64Url, deviceLabel, isAppleMobile, parseTime, reminderTime, sameKey, testResult } from "../src/web/lib/push";

const UA = {
  chromeWindows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  operaWindows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0",
  edgeWindows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  firefoxWindows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
  chromeAndroid: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  samsungAndroid: "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
  safariIphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  chromeIphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1",
  safariMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  chromeLinux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

describe("device names", () => {
  it("names the browser and the system like people say them", () => {
    expect(deviceLabel(UA.chromeWindows)).toBe("Chrome on Windows");
    expect(deviceLabel(UA.operaWindows)).toBe("Opera on Windows");
    expect(deviceLabel(UA.edgeWindows)).toBe("Edge on Windows");
    expect(deviceLabel(UA.firefoxWindows)).toBe("Firefox on Windows");
    expect(deviceLabel(UA.chromeAndroid)).toBe("Chrome on Android");
    expect(deviceLabel(UA.samsungAndroid)).toBe("Samsung Internet on Android");
    expect(deviceLabel(UA.safariIphone)).toBe("Safari on iPhone");
    expect(deviceLabel(UA.chromeIphone)).toBe("Chrome on iPhone");
    expect(deviceLabel(UA.safariMac)).toBe("Safari on Mac");
    expect(deviceLabel(UA.chromeLinux)).toBe("Chrome on Linux");
    expect(deviceLabel("")).toBe("Browser");
  });

  it("tells an iPad (which says Mac) by its touch screen, and Brave (which says Chrome) by the page", () => {
    expect(deviceLabel(UA.safariMac, { touchPoints: 5 })).toBe("Safari on iPad");
    expect(isAppleMobile(UA.safariMac, 5)).toBe(true);
    expect(isAppleMobile(UA.safariMac, 0)).toBe(false);
    expect(isAppleMobile(UA.safariIphone)).toBe(true);
    expect(isAppleMobile(UA.chromeAndroid)).toBe(false);
    expect(deviceLabel(UA.chromeWindows, { brave: true })).toBe("Brave on Windows");
  });
});

describe("the server's key", () => {
  // A P-256 public key in the form servers publish it (uncompressed point, base64url without padding).
  const key = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";

  it("turns base64url into the 65 bytes of the point, and back", () => {
    const bytes = base64UrlToBytes(key);
    expect(bytes.length).toBe(65);
    expect(bytes[0]).toBe(4);
    expect(bytesToBase64Url(bytes)).toBe(key);
    expect(bytesToBase64Url(bytes.buffer as ArrayBuffer)).toBe(key);
  });

  it("handles every padding length and the URL-safe letters", () => {
    for (const bytes of [[255], [251, 255], [0, 62, 63], [248, 0, 63, 191]]) {
      const text = bytesToBase64Url(new Uint8Array(bytes));
      expect(text).not.toMatch(/[+/=]/);
      expect([...base64UrlToBytes(text)]).toEqual(bytes);
    }
  });

  it("knows whether a subscription was made with this key", () => {
    const bytes = base64UrlToBytes(key);
    expect(sameKey(bytes.slice().buffer as ArrayBuffer, bytes)).toBe(true);
    const other = bytes.slice();
    other[10] = other[10]! ^ 1;
    expect(sameKey(other, bytes)).toBe(false);
    expect(sameKey(bytes.slice(1), bytes)).toBe(false);
    expect(sameKey(null, bytes)).toBe(false);
  });
});

describe("times", () => {
  it("reads the briefing time from the picker as HH:MM", () => {
    expect(parseTime("22:00")).toBe("22:00");
    expect(parseTime("7:05")).toBe("07:05");
    expect(parseTime("22:00:00")).toBe("22:00");
    expect(parseTime("00:00")).toBe("00:00");
    expect(parseTime("23:59")).toBe("23:59");
    expect(parseTime("24:00")).toBeNull();
    expect(parseTime("12:60")).toBeNull();
    expect(parseTime("")).toBeNull();
    expect(parseTime("10 PM")).toBeNull();
  });

  it("says when a reminder is due in its own time zone: today, tomorrow, or the date", () => {
    // Wednesday 25 November 2026, 15:00 in Pakistan (UTC+5).
    const now = Date.UTC(2026, 10, 25, 10, 0);
    const zone = "Asia/Karachi";
    expect(reminderTime(Date.UTC(2026, 10, 25, 12, 0), zone, now)).toBe("Today, 17:00");
    expect(reminderTime(Date.UTC(2026, 10, 26, 4, 0), zone, now)).toBe("Tomorrow, 09:00");
    // Still the 25th in UTC, already the 26th in Pakistan.
    expect(reminderTime(Date.UTC(2026, 10, 25, 19, 30), zone, now)).toBe("Tomorrow, 00:30");
    expect(reminderTime(Date.UTC(2026, 10, 27, 4, 0), zone, now)).toBe("Fri 27 Nov, 09:00");
    expect(reminderTime(Date.UTC(2027, 0, 5, 4, 0), zone, now)).toBe("Tue 5 Jan 2027, 09:00");
    // The same moment in New York (UTC-5) is still the evening of the 25th.
    expect(reminderTime(Date.UTC(2026, 10, 26, 4, 0), "America/New_York", now)).toBe("Today, 23:00");
  });

  it("still shows a time when the reminder's zone is unknown", () => {
    expect(reminderTime(Date.UTC(2026, 10, 25, 12, 0), "Not/AZone", Date.UTC(2026, 10, 25, 10, 0))).toMatch(/\d{2}:\d{2}$/);
  });
});

describe("the test notification's result", () => {
  it("says how many devices it reached", () => {
    expect(testResult({ sent: 2, failed: 0 })).toBe("Sent to 2 devices.");
    expect(testResult({ sent: 1, failed: 0 })).toBe("Sent to 1 device.");
    expect(testResult({ sent: 1, failed: 1 })).toBe("Sent to 1 device. 1 device couldn't be reached.");
    expect(testResult({ sent: 0, failed: 0 })).toBe("No device has notifications on yet.");
    expect(testResult({ sent: 0, failed: 3 })).toBe("Couldn't reach any of your 3 devices.");
  });
});

describe("VESPER Agent from a notification", () => {
  it("opens the agent from the link, and starts the briefing only for ?agent=briefing", () => {
    expect(agentLink("?agent=briefing")).toBe("briefing");
    expect(agentLink("?agent=1")).toBe("open");
    expect(agentLink("?x=2&agent=1")).toBe("open");
    expect(agentLink("")).toBeNull();
    expect(agentLink("?google=connected")).toBeNull();
  });

  it("asks for today's briefing before 15:00 and tomorrow's from then", () => {
    const at = (hour: number, minute = 0) => new Date(2026, 10, 25, hour, minute);
    expect(briefingRequest(at(8))).toBe("Brief me for today.");
    expect(briefingRequest(at(14, 59))).toBe("Brief me for today.");
    expect(briefingRequest(at(15))).toBe("Brief me for tomorrow.");
    expect(briefingRequest(at(22))).toBe("Brief me for tomorrow.");
  });

  it("asks about the notification's day, against this browser's date", () => {
    // Wednesday 25 November 2026, local time.
    const late = new Date(2026, 10, 25, 22, 0);
    const early = new Date(2026, 10, 25, 8, 0);
    expect(briefingRequest(late, "2026-11-25")).toBe("Brief me for today.");
    expect(briefingRequest(early, "2026-11-26")).toBe("Brief me for tomorrow.");
    // Tapped after midnight: the briefing sent at 22:00 is about today now.
    expect(briefingRequest(new Date(2026, 10, 26, 0, 30), "2026-11-26")).toBe("Brief me for today.");
    expect(briefingRequest(late, "2026-11-28")).toBe("Brief me for Saturday.");
    expect(briefingRequest(late, "2026-11-24")).toBe("Brief me for Tuesday.");
    // No day, or not a date: the time decides.
    expect(briefingRequest(late, null)).toBe("Brief me for tomorrow.");
    expect(briefingRequest(early, "2026-02-30")).toBe("Brief me for today.");
  });

  it("reads the day from the link only when it is a real date", () => {
    expect(briefingDayOf("?agent=briefing&day=2026-11-26")).toBe("2026-11-26");
    expect(briefingDayOf("?agent=briefing")).toBeNull();
    expect(briefingDayOf("?agent=briefing&day=2026-13-01")).toBeNull();
    expect(briefingDayOf("?agent=briefing&day=2026-11-26T00:00")).toBeNull();
    expect(briefingDayOf("?agent=briefing&day=26-11-2026")).toBeNull();
  });
});

describe("spoken progress line", () => {
  it("has a short line for each kind of step, and a plain one otherwise", () => {
    expect(progressLine("calendar_events")).toBe("Let me check your calendar.");
    expect(progressLine("calendar_free_time")).toBe("Let me check your calendar.");
    expect(progressLine("web_search")).toBe("Let me look that up.");
    expect(progressLine("weather")).toBe("Checking the weather.");
    expect(progressLine("search_documents")).toBe("Let me look in your documents.");
    expect(progressLine("read_document")).toBe("Let me look in your documents.");
    expect(progressLine("set_reminder")).toBe("Setting that reminder.");
    expect(progressLine("gmail_send")).toBe("Preparing that for you.");
    expect(progressLine("calendar_create_event")).toBe("Preparing that for you.");
    expect(progressLine("calculator")).toBe("One moment.");
    expect(progressLine("something_new")).toBe("One moment.");
  });

  it("says nothing for the chat's own bookkeeping", () => {
    expect(progressLine("context_summary")).toBeNull();
  });
});
