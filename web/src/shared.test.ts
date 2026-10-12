import { describe, expect, it } from "vitest";
import { charLength, trimPadding } from "./shared";

describe("limits shared with the server", () => {
  it("counts length in code points, so an emoji is one character", () => {
    expect(charLength("\u{1f600}\u{1f600}")).toBe(2);
  });

  it("strips the edge padding the server strips, and keeps inner whitespace", () => {
    expect(trimPadding(" ​ Buy milk\nand bread ﻿")).toBe("Buy milk\nand bread");
  });
});
