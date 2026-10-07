import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it.each([
    ["missing", { AI_PROVIDER: "openai" }],
    ["blank", { AI_PROVIDER: "openai", OPENAI_API_KEY: "   " }],
  ] as const)("rejects an openai config with a %s API key", (_case, env) => {
    expect(() => loadConfig(env)).toThrow(/OPENAI_API_KEY is required/);
  });

  it("accepts the fake provider without a key", () => {
    expect(loadConfig({ AI_PROVIDER: "fake" }).AI_PROVIDER).toBe("fake");
  });

  it("trims a provided openai key", () => {
    expect(loadConfig({ AI_PROVIDER: "openai", OPENAI_API_KEY: "  sk-test  " }).OPENAI_API_KEY).toBe("sk-test");
  });
});
