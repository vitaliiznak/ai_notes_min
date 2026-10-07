import { z } from "zod";

const Env = z.object({
  DATABASE_URL: z.string().min(1).default("postgres://notes:notes@localhost:5432/notes"),
  PORT: z.coerce.number().int().positive().default(3000),
  AI_PROVIDER: z.enum(["openai", "fake"]).default("openai"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().min(1).default("gpt-6-luna"),
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  // When set, the API also serves the built frontend from this directory.
  STATIC_DIR: z.string().min(1).optional(),
});

export type Config = z.infer<typeof Env>;

/** Initial request plus the one SDK retry. */
export const AI_ATTEMPTS = 2;
const DRAIN_SLACK_MS = 15_000;

/** Worst case for in-flight calls after SIGTERM: each attempt can use the full timeout, plus retry backoff. */
export function drainBudgetMs(timeoutMs: number): number {
  return timeoutMs * AI_ATTEMPTS + DRAIN_SLACK_MS;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  }
  const config = parsed.data;
  if (config.AI_PROVIDER === "openai") {
    const key = config.OPENAI_API_KEY?.trim() ?? "";
    if (!key) throw new Error("Invalid environment:\nOPENAI_API_KEY is required when AI_PROVIDER=openai.");
    return { ...config, OPENAI_API_KEY: key };
  }
  return config;
}
