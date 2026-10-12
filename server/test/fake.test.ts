import { describe, expect, it } from "vitest";
import { createFakeProvider } from "../src/ai/fake.js";
import { acceptSummary, acceptTags } from "../src/notes/ai-output.js";
import { SUMMARY_MIN_CONTENT } from "../src/shared/rules.js";

describe("fake provider tags", () => {
  it("returns one fallback tag when the note has no usable word", async () => {
    const output = await createFakeProvider().generateTags({ title: "Hi", content: "ok" });

    expect(acceptTags(output)).toEqual(["fake-ai"]);
  });

  it("returns the note's own word, without padding", async () => {
    const output = await createFakeProvider().generateTags({ title: "Postgres", content: "postgres" });

    expect(acceptTags(output)).toEqual(["postgres"]);
  });
});

describe("fake provider summary", () => {
  it("passes the summary rules, even with a long title", async () => {
    const note = { title: "t".repeat(200), content: "word ".repeat(SUMMARY_MIN_CONTENT / 5) };
    const output = await createFakeProvider().summarize(note);

    const summary = `[fake AI] Summary of "${"t".repeat(40)}". Begins: "${"word ".repeat(28)}…"`;
    expect(output.summary).toBe(summary);
    expect(acceptSummary(output, note.content)).toBe(summary);
  });
});

describe("fake provider summary and tags", () => {
  it("passes both rules from one call", async () => {
    const note = { title: "Postgres upgrade", content: "Upgrade postgres on friday. ".repeat(20) };
    const output = await createFakeProvider().summarizeAndTag(note);

    expect(acceptTags(output)).toEqual(["postgres", "upgrade", "friday"]);
    const summary = `[fake AI] Summary of "Postgres upgrade". Begins: "${"Upgrade postgres on friday. ".repeat(5)}…"`;
    expect(output.summary).toBe(summary);
    expect(acceptSummary(output, note.content)).toBe(summary);
  });
});
