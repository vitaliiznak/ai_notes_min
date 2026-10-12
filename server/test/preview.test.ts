import { describe, expect, it } from "vitest";
import { previewModelText } from "../src/notes/enrichment.js";

describe("previewModelText", () => {
  it("shows finished tags and the one still being written", () => {
    expect(previewModelText("tags", '{"tags":["postgres","upgr')).toEqual({ tags: ["postgres", "upgr"] });
    expect(previewModelText("tags", '{"tags":["#Postgres","trip ')).toEqual({ tags: ["postgres", "trip"] });
    expect(previewModelText("tags", '{"tags":["#Post')).toEqual({ tags: ["post"] });
  });

  it("decodes escapes and stops before a dangling one", () => {
    expect(previewModelText("tags", '{"tags":["say \\"hi\\"","next')).toEqual({ tags: ['say "hi"', "next"] });
    expect(previewModelText("tags", '{"tags":["hi\\')).toEqual({ tags: ["hi"] });
    expect(previewModelText("summary", '{"summary":"Say \\"hi\\"."}')).toEqual({ summary: 'Say "hi".' });
    expect(previewModelText("summary", '{"summary":"hi\\')).toEqual({ summary: "hi" });
  });

  it("returns null until the field's value has started", () => {
    expect(previewModelText("tags", "")).toBeNull();
    expect(previewModelText("tags", '{"tags"')).toBeNull();
    expect(previewModelText("tags", '{"summary":')).toBeNull();
    expect(previewModelText("summary", '{"summary"')).toBeNull();
    expect(previewModelText("summary", '{"summary":"')).toBeNull();
  });

  it("reads the summary key, not the same word inside another value", () => {
    expect(previewModelText("summary", '{"tags":["summary"],"summary":"Real')).toEqual({ summary: "Real" });
  });

  it("trims the summary so far as it will be stored", () => {
    expect(previewModelText("summary", '{"summary":"\u200bUpgrade is Friday. ')).toEqual({
      summary: "Upgrade is Friday.",
    });
    expect(previewModelText("summary", '{"summary":"\u200b  Upgrade is Friday.  "}')).toEqual({
      summary: "Upgrade is Friday.",
    });
  });

  it("normalises and dedupes finished tags", () => {
    expect(previewModelText("tags", '{"tags":["#Postgres","postgres","Friday"]}')).toEqual({
      tags: ["postgres", "friday"],
    });
  });
});
