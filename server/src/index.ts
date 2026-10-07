import { createFakeProvider } from "./ai/fake.js";
import { createOpenAiProvider } from "./ai/openai.js";
import { createApp } from "./app.js";
import { drainBudgetMs, loadConfig } from "./config.js";
import { createPool, migrateSchema } from "./db.js";

const config = loadConfig();
// Built before touching the database so bad AI config (e.g. no key) fails fast.
const ai =
  config.AI_PROVIDER === "fake"
    ? createFakeProvider()
    : createOpenAiProvider({
        model: config.OPENAI_MODEL,
        timeoutMs: config.AI_TIMEOUT_MS,
        apiKey: config.OPENAI_API_KEY,
      });
const pool = createPool(config.DATABASE_URL);

await migrateSchema(pool);

const { app, idle } = createApp({ pool, ai, staticDir: config.STATIC_DIR });
const server = app.listen(config.PORT, () => {
  console.log(`API listening on :${config.PORT} (AI provider: ${config.AI_PROVIDER}${config.AI_PROVIDER === "openai" ? `, model: ${config.OPENAI_MODEL}` : ""})`);
});

let draining = false;
function shutdown(signal: string) {
  if (draining) {
    console.log(`${signal} received again, exiting`);
    process.exit(1);
  }
  draining = true;
  console.log(`${signal} received, draining connections`);
  const timer = setTimeout(() => process.exit(1), drainBudgetMs(config.AI_TIMEOUT_MS));
  timer.unref();
  server.close(() => {
    // A new note's AI calls outlive its request. Let them store their result before the pool closes.
    void idle()
      .then(() => pool.end())
      .then(() => {
        clearTimeout(timer);
        process.exit(0);
      });
  });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
