import { describe, expect, it } from "vitest";
import { parsePartialField } from "../src/notes/ai-output.js";

describe("parsePartialField", () => {
  it("shows finished tags and the one still being written", () => {
    expect(parsePartialField("tags", '{"tags":["postgres","upgr')).toEqual({ tags: ["postgres", "upgr"] });
    expect(parsePartialField("tags", '{"tags":["#Postgres","trip ')).toEqual({ tags: ["postgres", "trip"] });
    expect(parsePartialField("tags", '{"tags":["#Post')).toEqual({ tags: ["post"] });
  });

  it("decodes escapes and stops before a dangling one", () => {
    expect(parsePartialField("tags", '{"tags":["say \\"hi\\"","next')).toEqual({ tags: ['say "hi"', "next"] });
    expect(parsePartialField("tags", '{"tags":["hi\\')).toEqual({ tags: ["hi"] });
    expect(parsePartialField("summary", '{"summary":"Say \\"hi\\"."}')).toEqual({ summary: 'Say "hi".' });
    expect(parsePartialField("summary", '{"summary":"hi\\')).toEqual({ summary: "hi" });
  });

  it("returns null until the field's value has started", () => {
    expect(parsePartialField("tags", "")).toBeNull();
    expect(parsePartialField("tags", '{"tags"')).toBeNull();
    expect(parsePartialField("tags", '{"summary":')).toBeNull();
    expect(parsePartialField("summary", '{"summary"')).toBeNull();
    expect(parsePartialField("summary", '{"summary":"')).toBeNull();
  });

  it("reads the summary key, not the same word inside another value", () => {
    expect(parsePartialField("summary", '{"tags":["summary"],"summary":"Real')).toEqual({ summary: "Real" });
  });

  it("trims the summary so far as it will be stored", () => {
    expect(parsePartialField("summary", '{"summary":"\u200bUpgrade is Friday. ')).toEqual({
      summary: "Upgrade is Friday.",
    });
    expect(parsePartialField("summary", '{"summary":"\u200b  Upgrade is Friday.  "}')).toEqual({
      summary: "Upgrade is Friday.",
    });
  });

  it("normalises and dedupes finished tags", () => {
    expect(parsePartialField("tags", '{"tags":["#Postgres","postgres","Friday"]}')).toEqual({
      tags: ["postgres", "friday"],
    });
  });
});
