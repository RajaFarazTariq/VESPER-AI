/**
 * VESPER Agent (v0.17.0), the browser side that needs nothing from the page itself: the greeting, how a reply being
 * written is cut into sentences to speak, and when a listening turn is over.
 */
import { describe, expect, it } from "vitest";
import { agentGreeting, LISTEN_TIMING, loudness, nextSentences, SilenceDetector, speechChunks, type ListenVerdict } from "../src/web/lib/agent-voice";

const at = (hour: number) => new Date(2026, 10, 25, hour, 30);

describe("greeting", () => {
  it("says good morning, afternoon or evening by the local time, with the first name", () => {
    expect(agentGreeting("Sara Khan", at(9))).toBe("Good morning, Sara. VESPER is online. How can I help?");
    expect(agentGreeting("Sara", at(13))).toBe("Good afternoon, Sara. VESPER is online. How can I help?");
    expect(agentGreeting("Sara", at(19))).toBe("Good evening, Sara. VESPER is online. How can I help?");
    expect(agentGreeting("Sara", at(2))).toBe("Good evening, Sara. VESPER is online. How can I help?");
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
