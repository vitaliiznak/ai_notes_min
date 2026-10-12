import { z } from "zod";
import { AI_MAX_RETRIES } from "./ai/provider.js";

const Env = z.object({
  DATABASE_URL: z.string().min(1).default("postgres://notes:notes@localhost:5432/notes"),
  PORT: z.coerce.number().int().positive().default(3000),
  AI_PROVIDER: z.enum(["openai", "fake"]).default("openai"),
  OPENAI_API_KEY: z.string().trim().optional(),
  OPENAI_MODEL: z.string().min(1).default("gpt-6-luna"),
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  // When set, the API also serves the built frontend from this directory.
  STATIC_DIR: z.string().min(1).optional(),
});

export type Config = z.infer<typeof Env>;

/** How long shutdown waits for running AI calls: every attempt an adapter may make at the full timeout, plus 15 s. */
export function drainBudgetMs(timeoutMs: number): number {
  return (AI_MAX_RETRIES + 1) * timeoutMs + 15_000;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  }
  if (parsed.data.AI_PROVIDER === "openai" && !parsed.data.OPENAI_API_KEY) {
    throw new Error("Invalid environment:\nOPENAI_API_KEY is required when AI_PROVIDER=openai.");
  }
  return parsed.data;
}
