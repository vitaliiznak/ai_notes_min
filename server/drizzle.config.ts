import { defineConfig } from "drizzle-kit";

// `npm run db:generate` diffs src/notes/table.ts against the last snapshot and writes the next migration.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/notes/table.ts",
  out: "./drizzle",
});
