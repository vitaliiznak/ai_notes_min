import { defineConfig } from "vitest/config";

// Covers the API client's own logic (SSE parsing, error mapping, the shared limits),
// which needs no DOM. The UI itself is covered end to end by Playwright, against the real server.
export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
