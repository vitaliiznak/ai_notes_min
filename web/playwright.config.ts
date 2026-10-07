import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { E2E_DATABASE_URL } from "./e2e/database";

const repoRoot = path.resolve(import.meta.dirname, "..");
const port = Number(process.env.E2E_PORT ?? 3100);
const baseURL = `http://127.0.0.1:${port}`;

/**
 * Runs the specs against the real stack: the built UI served by the API process, on its own
 * database, with AI_PROVIDER=fake so the runs are deterministic and cost nothing.
 */
export default defineConfig({
  testDir: "./e2e",
  // One shared notebook with no accounts, so the specs take turns and each clears it first.
  workers: 1,
  // A retry would hide a flake, and these specs wait for the UI rather than for time.
  retries: 0,
  // On CI the HTML report (with the trace of any failure) is uploaded as an artifact.
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "list",
  use: { baseURL, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // The database is created and emptied first; the server then applies the migrations at boot.
    command: "npx tsx web/e2e/ensure-database.ts && npm run build && npm run start -w server",
    cwd: repoRoot,
    url: `${baseURL}/api/health`,
    // The build runs first, so allow for a cold one.
    timeout: 180_000,
    reuseExistingServer: false,
    env: {
      DATABASE_URL: E2E_DATABASE_URL,
      AI_PROVIDER: "fake",
      PORT: String(port),
      // `npm run -w server` runs in server/, so the UI directory is given in full.
      STATIC_DIR: path.resolve(import.meta.dirname, "dist"),
    },
  },
});
