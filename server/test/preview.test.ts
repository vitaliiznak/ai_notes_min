import { describe, expect, it } from "vitest";
import { previewModelText } from "../src/notes/enrichment.js";
import { partialJsonString, partialStringArray } from "../src/notes/preview.js";

describe("partial model text", () => {
  it("reads complete strings and the unfinished tail", () => {
    expect(partialStringArray('{"tags":["postgres","upgr', "tags")).toEqual({
      done: ["postgres"],
      tail: "upgr",
    });
  });

  it("decodes escapes inside a finished string and stops on a dangling escape", () => {
    expect(partialStringArray('{"tags":["say \\"hi\\"","next', "tags")).toEqual({
      done: ['say "hi"'],
      tail: "next",
    });
    expect(partialStringArray('{"tags":["hi\\', "tags")).toEqual({ done: [], tail: "hi" });
  });

  it("returns null until the array has started", () => {
    expect(partialStringArray('{"tags"', "tags")).toBeNull();
    expect(partialStringArray('{"summary":', "tags")).toBeNull();
  });

  it("reads a summary string while it is still being written", () => {
    expect(partialJsonString('{"summary":"Upgrade is Friday.', "summary")).toEqual({
      value: "Upgrade is Friday.",
      closed: false,
    });
    expect(partialJsonString('{"summary":"Say \\"hi\\"."}', "summary")).toEqual({ value: 'Say "hi".', closed: true });
    expect(partialJsonString('{"summary":"hi\\', "summary")).toEqual({ value: "hi", closed: false });
    expect(partialJsonString('{"summary"', "summary")).toBeNull();
    expect(partialJsonString('{"tags":["summary"],"summary":"Real', "summary")).toEqual({ value: "Real", closed: false });
  });

  it("turns a partial summary into the text so far, and tags into a normalised list", () => {
    expect(previewModelText("summary", '{"summary":"\u200bUpgrade is Friday. ')).toEqual({
      summary: "Upgrade is Friday. ",
    });
    expect(previewModelText("summary", '{"summary":"\u200b  Upgrade is Friday.  "}')).toEqual({
      summary: "Upgrade is Friday.",
    });
    expect(previewModelText("tags", '{"tags":["#Postgres","postgres","Friday"]}')).toEqual({
      tags: ["postgres", "friday"],
    });
    expect(previewModelText("tags", '{"tags":["#Postgres","trip ')).toEqual({ tags: ["postgres", "trip "] });
    expect(previewModelText("tags", '{"tags":["#Post')).toEqual({ tags: ["post"] });
  });
});
