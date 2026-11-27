/**
 * VESPER Agent (v0.17.0), the browser side that needs nothing from the page itself: the greeting, how a reply being
 * written is cut into sentences to speak, and when a listening turn is over. v0.17.1: the studio voice's requests and
 * the best female device voice.
 */
import { describe, expect, it } from "vitest";
import {
  agentGreeting,
  LISTEN_TIMING,
  loudness,
  nextSentences,
  nextUtcMidnight,
  rankVoices,
  SilenceDetector,
  speechChunks,
  takeChunks,
  voiceScore,
  type ListenVerdict,
} from "../src/web/lib/agent-voice";

const at = (hour: number) => new Date(2026, 10, 25, hour, 30);

describe("greeting", () => {
  it("says good morning, afternoon or evening by the local time, with the first name", () => {
    expect(agentGreeting("Sara Khan", at(9))).toBe("Good morning, Sara. VESPER is online. How can I help?");
    expect(agentGreeting("Sara", at(13))).toBe("Good afternoon, Sara. VESPER is online. How can I help?");
    expect(agentGreeting("Sara", at(19))).toBe("Good evening, Sara. VESPER is online. How can I help?");
    expect(agentGreeting("Sara", at(23))).toBe("Good evening, Sara. VESPER is online. How can I help?");
  });

  it('says "Hello" from midnight to 04:59, then good morning from 05:00', () => {
    expect(agentGreeting("Sara", new Date(2026, 10, 25, 0, 0))).toBe("Hello, Sara. VESPER is online. How can I help?");
    expect(agentGreeting("Sara", at(2))).toBe("Hello, Sara. VESPER is online. How can I help?");
    expect(agentGreeting(null, new Date(2026, 10, 25, 4, 59))).toBe("Hello. VESPER is online. How can I help?");
    expect(agentGreeting("Sara", new Date(2026, 10, 25, 5, 0))).toBe("Good morning, Sara. VESPER is online. How can I help?");
  });

  it("greets without a name when there is none", () => {
    expect(agentGreeting(null, at(9))).toBe("Good morning. VESPER is online. How can I help?");
    expect(agentGreeting("   ", at(13))).toBe("Good afternoon. VESPER is online. How can I help?");
  });
});

describe("sentences to speak while the reply is written", () => {
  it("returns the complete sentences and leaves the rest for later", () => {
    const text = "Sure thing. I checked your cal";
    const split = nextSentences(text);
    expect(split.sentences).toEqual(["Sure thing."]);
    expect(text.slice(split.consumed).trim()).toBe("I checked your cal");
  });

  it("waits at a mark at the very end, and takes the rest when the reply is done", () => {
    expect(nextSentences("It is 3.").sentences).toEqual([]);
    expect(nextSentences("It is 3.5 degrees.").sentences).toEqual([]);
    expect(nextSentences("It is 3.5 degrees.", true).sentences).toEqual(["It is 3.5 degrees."]);
    expect(nextSentences("Really?! Yes", true).sentences).toEqual(["Really?!", "Yes"]);
  });

  it("doesn't end a sentence at abbreviations, initials, decimals or list numbers", () => {
    expect(nextSentences("Dr. Ali is in at 9.30 a.m. today. Next").sentences).toEqual(["Dr. Ali is in at 9.30 a.m. today."]);
    expect(nextSentences("Bring fruit, e.g. apples. Then").sentences).toEqual(["Bring fruit, e.g. apples."]);
    expect(nextSentences("1. Milk\n2. Bread\n").sentences).toEqual(["1. Milk", "2. Bread"]);
  });

  it('ends at "No." unless a number follows, and after a decimal number when a new sentence starts', () => {
    expect(nextSentences("No. You're free tomorrow. Any").sentences).toEqual(["No.", "You're free tomorrow."]);
    expect(nextSentences("Room No. 5 is free. Next").sentences).toEqual(["Room No. 5 is free."]);
    expect(nextSentences("It's $3.50. Want more?", true).sentences).toEqual(["It's $3.50.", "Want more?"]);
    expect(nextSentences("Build 2.1. and later builds. Ok").sentences).toEqual(["Build 2.1. and later builds."]);
    // What follows hasn't arrived yet: it waits.
    expect(nextSentences("No. ").sentences).toEqual([]);
    expect(nextSentences("It's $3.50. ").sentences).toEqual([]);
    expect(nextSentences("No. ", true).sentences).toEqual(["No."]);
  });

  it("ends at line breaks and after closing quotes or emphasis", () => {
    expect(nextSentences("## Weather\nSunny all day.\n").sentences).toEqual(["## Weather", "Sunny all day."]);
    expect(nextSentences('"Done." **Sent.** Next').sentences).toEqual(['"Done."', "**Sent.**"]);
  });

  it("ends Urdu sentences at the Urdu full stop", () => {
    expect(nextSentences("یہ ٹھیک ہے۔ اگلا").sentences).toEqual(["یہ ٹھیک ہے۔"]);
  });

  it("holds a code block back until it is closed", () => {
    const open = "Here it is:\n```js\nconst a = 1. b\n";
    const split = nextSentences(open);
    expect(split.sentences).toEqual(["Here it is:"]);
    expect(split.consumed).toBe("Here it is:\n".length);
    const closed = nextSentences("```js\nconst a = 1. b\n```\nDone. Bye");
    expect(closed.sentences).toEqual(["```js\nconst a = 1. b\n```", "Done."]);
  });

  it("gives the same sentences however the text arrives", () => {
    /** The sentences heard when `full` arrives `size` characters at a time. */
    const streamed = (full: string, size: number) => {
      const heard: string[] = [];
      let upTo = 0;
      for (let end = size; ; end += size) {
        const done = end >= full.length;
        const { sentences, consumed } = nextSentences(full.slice(upTo, Math.min(end, full.length)), done);
        heard.push(...sentences);
        upTo += consumed;
        if (done) return heard;
      }
    };
    const first = "Sure. I checked your calendar: you have 2 meetings, at 9.30 and 14.00.\nDr. Ali's is first. Anything else?";
    const second = "No. Room No. 5 costs $3.50. Want it? Yes.";
    for (const full of [first, second]) {
      const expected = nextSentences(full, true).sentences;
      for (const size of [1, 2, 3, 5, 8, 13]) expect(streamed(full, size)).toEqual(expected);
    }
    expect(nextSentences(first, true).sentences).toEqual([
      "Sure.",
      "I checked your calendar: you have 2 meetings, at 9.30 and 14.00.",
      "Dr. Ali's is first.",
      "Anything else?",
    ]);
    expect(nextSentences(second, true).sentences).toEqual(["No.", "Room No. 5 costs $3.50.", "Want it?", "Yes."]);
  });

  it("cuts long sentences into pieces, at a comma where possible", () => {
    expect(speechChunks("A short one.")).toEqual(["A short one."]);
    const long = `${"word ".repeat(30).trim()}, ${"more ".repeat(40).trim()}.`;
    const pieces = speechChunks(long);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((p) => p.length <= 220)).toBe(true);
    expect(pieces[0]!.endsWith(",")).toBe(true);
    expect(pieces.join(" ")).toBe(long);
    expect(speechChunks("x".repeat(500)).every((p) => p.length <= 220)).toBe(true);
  });
});

describe("listening", () => {
  it("measures loudness on a 0..1 scale", () => {
    expect(loudness([])).toBe(0);
    expect(loudness(new Float32Array(512))).toBe(0);
    expect(loudness(new Float32Array(512).fill(1))).toBe(1);
    expect(loudness(new Float32Array(512).fill(0.01))).toBeCloseTo(0.18, 2);
  });

  /** Feeds readings every `step` ms from `from` (inclusive) to `to` (exclusive); returns the first verdict that isn't "listening". */
  const run = (detector: SilenceDetector, from: number, to: number, level: number, step = 50): { verdict: ListenVerdict; at: number } => {
    for (let t = from; t < to; t += step) {
      const verdict = detector.feed(level, t);
      if (verdict !== "listening") return { verdict, at: t };
    }
    return { verdict: "listening", at: to };
  };

  it("stops about 1.2 seconds after you stop talking", () => {
    const d = new SilenceDetector(0);
    expect(run(d, 0, 1000, 0.05).verdict).toBe("listening");
    expect(run(d, 1000, 2500, 0.5).verdict).toBe("listening");
    expect(d.speechHeard).toBe(true);
    expect(run(d, 2500, 10_000, 0.05)).toEqual({ verdict: "silence", at: 2450 + LISTEN_TIMING.silenceMs });
  });

  it("gives up when nothing is said in time, and a click or a cough isn't speech", () => {
    expect(run(new SilenceDetector(0), 0, 20_000, 0.05)).toEqual({ verdict: "no-speech", at: LISTEN_TIMING.noSpeechMs });
    const d = new SilenceDetector(0);
    run(d, 0, 3000, 0.05);
    run(d, 3000, 3100, 0.8); // 100 ms
    expect(d.speechHeard).toBe(false);
    expect(run(d, 3100, 20_000, 0.05)).toEqual({ verdict: "no-speech", at: LISTEN_TIMING.noSpeechMs });
  });

  it("stops at the time limit while you keep talking", () => {
    const d = new SilenceDetector(1000, { maxMs: 10_000 });
    run(d, 1000, 1300, 0.05);
    expect(run(d, 1300, 60_000, 0.6)).toEqual({ verdict: "limit", at: 11_000 });
  });

  it("allows for a noisy room", () => {
    const d = new SilenceDetector(0);
    run(d, 0, 250, 0.3);
    // The room's own noise isn't speech...
    expect(run(d, 250, 4000, 0.35).verdict).toBe("listening");
    expect(d.speechHeard).toBe(false);
    // ...a voice above it is, and the noise afterwards counts as silence.
    run(d, 4000, 5000, 0.75);
    expect(d.speechHeard).toBe(true);
    expect(run(d, 5000, 10_000, 0.35).verdict).toBe("silence");
  });

  it("works the same with readings far apart (a tab in the background)", () => {
    const d = new SilenceDetector(0);
    expect(d.feed(0.05, 0)).toBe("listening");
    expect(d.feed(0.5, 1000)).toBe("listening");
    expect(d.feed(0.5, 2000)).toBe("listening");
    expect(d.feed(0.05, 3000)).toBe("listening");
    expect(d.feed(0.05, 4000)).toBe("silence");
  });
});

// ------------------------------------------------------------------ v0.17.1: the studio voice and the device voices

describe("requests for the studio voice", () => {
  const s = (n: number, letter = "a") => `${letter.repeat(n - 1)}.`;

  it("starts with the first sentence alone, then joins sentences up to about 250 characters", () => {
    const sentences = [s(40, "a"), s(100, "b"), s(100, "c"), s(100, "d"), s(30, "e")];
    const { chunks, rest } = takeChunks(sentences, { starting: true, final: false });
    expect(chunks[0]).toBe(sentences[0]);
    expect(chunks[1]).toBe(`${sentences[1]} ${sentences[2]}`);
    // The last group (d + e, 131 characters) waits for more text...
    expect(chunks).toHaveLength(2);
    expect(rest).toEqual([`${sentences[3]} ${sentences[4]}`]);
    // ...and goes when the reply is done.
    expect(takeChunks(rest, { starting: false, final: true })).toEqual({ chunks: [`${sentences[3]} ${sentences[4]}`], rest: [] });
  });

  it("keeps the first piece short and never sends more than 600 characters", () => {
    const long = `${"word ".repeat(150).trim()}.`; // 750 characters
    const { chunks } = takeChunks([long, "Then this."], { starting: true, final: true });
    expect(chunks[0]!.length).toBeLessThanOrEqual(200);
    expect(chunks.every((c) => c.length <= 600)).toBe(true);
    expect(chunks.join(" ")).toBe(`${long} Then this.`);
  });

  it("sends a group that is already long enough without waiting", () => {
    expect(takeChunks([s(260)], { starting: false, final: false })).toEqual({ chunks: [s(260)], rest: [] });
    expect(takeChunks([], { starting: true, final: true })).toEqual({ chunks: [], rest: [] });
  });

  it("knows when the day's allowance comes back (00:00 UTC)", () => {
    expect(new Date(nextUtcMidnight(Date.UTC(2026, 10, 25, 23, 59, 59))).toISOString()).toBe("2026-11-26T00:00:00.000Z");
    expect(new Date(nextUtcMidnight(Date.UTC(2026, 11, 31, 0, 0, 0))).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
});

describe("the best female device voice", () => {
  const voice = (name: string, lang = "en-US", localService = true, isDefault = false) => ({ name, lang, localService, default: isDefault });

  it("Chrome on Windows: Google's female voices first, Zira before the male voices", () => {
    const chrome = [
      voice("Microsoft David - English (United States)", "en-US", true, true),
      voice("Microsoft Mark - English (United States)"),
      voice("Microsoft Zira - English (United States)"),
      voice("Google Deutsch", "de-DE", false),
      voice("Google US English", "en-US", false),
      voice("Google UK English Female", "en-GB", false),
      voice("Google UK English Male", "en-GB", false),
    ];
    expect(rankVoices(chrome).map((v) => v.name)).toEqual([
      "Google UK English Female",
      "Google US English",
      "Microsoft Zira - English (United States)",
      "Google UK English Male",
      "Microsoft David - English (United States)",
      "Microsoft Mark - English (United States)",
    ]);
  });

  it("Opera on Windows (no Google voices): Zira, never David or Mark", () => {
    const opera = [voice("Microsoft David - English (United States)", "en-US", true, true), voice("Microsoft Mark"), voice("Microsoft Zira")];
    expect(rankVoices(opera)[0]!.name).toBe("Microsoft Zira");
  });

  it("Edge: a natural online female voice", () => {
    const edge = [
      voice("Microsoft Guy Online (Natural) - English (United States)", "en-US", false),
      voice("Microsoft AndrewMultilingual Online (Natural) - English (United States)", "en-US", false),
      voice("Microsoft Zira - English (United States)"),
      voice("Microsoft AvaMultilingual Online (Natural) - English (United States)", "en-US", false),
      voice("Microsoft Sonia Online (Natural) - English (United Kingdom)", "en-GB", false),
    ];
    const ranked = rankVoices(edge).map((v) => v.name);
    expect(ranked[0]).toMatch(/AvaMultilingual|Sonia/);
    expect(ranked.slice(-2).every((n) => /Guy|Andrew/.test(n))).toBe(true);
  });

  it("Apple and Android voices; only the reply's language; a male voice only when there's nothing else", () => {
    expect(rankVoices([voice("Daniel", "en-GB"), voice("Fred"), voice("Samantha"), voice("Karen", "en-AU")])[0]!.name).toBe("Samantha");
    expect(rankVoices([voice("en-us-x-iom-local"), voice("en-us-x-sfg-local")])[0]!.name).toBe("en-us-x-sfg-local");
    expect(rankVoices([voice("Google Deutsch", "de-DE", false), voice("Google US English", "en-US", false)]).map((v) => v.name)).toEqual([
      "Google US English",
    ]);
    expect(rankVoices([voice("Microsoft David")])[0]!.name).toBe("Microsoft David");
    expect(rankVoices([voice("Anna", "de-DE")])[0]!.name).toBe("Anna"); // no English voice at all: whatever there is
    expect(voiceScore(voice("Microsoft Zira"))).toBeLessThan(voiceScore(voice("Google US English", "en-US", false)));
  });

  it("Urdu: a female Urdu voice first", () => {
    const urdu = [
      voice("Microsoft Asad Online (Natural) - Urdu (Pakistan)", "ur-PK", false),
      voice("Microsoft Salman Online (Natural) - Urdu (India)", "ur-IN", false),
      voice("Microsoft Uzma Online (Natural) - Urdu (Pakistan)", "ur-PK", false),
      voice("Microsoft Gul Online (Natural) - Urdu (India)", "ur-IN", false),
      voice("Google US English", "en-US", false),
    ];
    const ranked = rankVoices(urdu, "ur").map((v) => v.name);
    expect(ranked.slice(0, 2)).toEqual(["Microsoft Uzma Online (Natural) - Urdu (Pakistan)", "Microsoft Gul Online (Natural) - Urdu (India)"]);
    expect(ranked).toHaveLength(4);
  });
});
