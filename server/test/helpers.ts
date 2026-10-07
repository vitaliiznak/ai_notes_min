import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import type { AiProvider, SummaryAndTagsOutput, SummaryOutput, TagsOutput } from "../src/ai/provider.js";
import { modelStream } from "../src/ai/stream.js";
import { createApp } from "../src/app.js";
import { canSummarize } from "../src/notes/limits.js";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://notes:notes@localhost:5432/notes_test";

/** Long enough to be summarized; most notes in these tests are not. */
export const LONG_NOTE = {
  title: "Postgres upgrade",
  content: [
    "Upgrade the main cluster from Postgres 15 to 17 on Friday at 18:00, after the weekly billing export finishes.",
    "Dana owns the runbook and Sam is on call; we freeze deploys from 16:00.",
    "Take a fresh base backup first and confirm the restore into staging works before touching production.",
    "pg_upgrade with --link keeps the downtime to about ten minutes, but there is no way back once the new cluster starts, so the rollback plan is the backup.",
    "Open question: the reporting replica still runs the old PostGIS extension, and nobody has checked whether 17 ships a compatible build.",
  ].join(" "),
};
if (!canSummarize(LONG_NOTE.content)) throw new Error("LONG_NOTE must be long enough to summarize.");

/** Runs `run` on the server's `postgres` database, to create or drop the test databases. */
export async function withAdmin<T>(run: (admin: pg.Client) => Promise<T>): Promise<T> {
  const admin = new pg.Client({
    connectionString: Object.assign(new URL(TEST_DATABASE_URL), { pathname: "/postgres" }).toString(),
  });
  await admin.connect();
  try {
    return await run(admin);
  } finally {
    await admin.end();
  }
}

export interface TestServer {
  url: string;
  /** Waits for AI calls a new note started after its response. */
  idle(): Promise<void>;
  close(): Promise<void>;
}

/** Starts a real HTTP server (its own app instance and single-flight map) on a random port. */
export async function startServer(pool: pg.Pool, ai: AiProvider): Promise<TestServer> {
  const { app, idle } = createApp({ pool, ai });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    idle,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await idle();
    },
  };
}

interface ApiResponse {
  status: number;
  body: any;
}

// Node's fetch sends no Origin. A mutation without one is rejected, so tests send the server's own unless a case overrides it.
export function sameOriginHeaders(baseUrl: string, headers: Record<string, string> = {}): Record<string, string> {
  return { origin: new URL(baseUrl).origin, ...headers };
}

export async function call(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<ApiResponse> {
  const sent = sameOriginHeaders(baseUrl, body === undefined ? headers : { "content-type": "application/json", ...headers });
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: sent,
    body: typeof body === "string" ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/**
 * Fake AI provider that counts calls. By default call n returns output that
 * mentions n, so results from different calls are distinguishable.
 */
export function scriptedAi(
  script: {
    summarize?: (n: number) => SummaryOutput;
    generateTags?: (n: number) => TagsOutput;
    /** The one call a new long note makes for both results. */
    summarizeAndTag?: (n: number) => SummaryAndTagsOutput;
    delayMs?: number;
    /** Pause between streamed chunks so a test can observe a preview before the call finishes. */
    streamDelayMs?: number;
  } = {},
) {
  const calls = { summary: 0, tags: 0, summaryAndTags: 0 };
  async function take<T>(key: keyof typeof calls, produce: ((n: number) => T) | undefined, fallback: (n: number) => T) {
    const n = ++calls[key];
    await sleep(script.delayMs ?? 0);
    return (produce ?? fallback)(n);
  }
  async function emitJson(emit: (delta: string) => void, value: unknown) {
    const json = JSON.stringify(value);
    const size = 12;
    for (let i = 0; i < json.length; i += size) {
      if (script.streamDelayMs) await sleep(script.streamDelayMs);
      emit(json.slice(i, i + size));
    }
  }
  const provider: AiProvider = {
    summarize: () =>
      modelStream(async (emit) => {
        const value = await take("summary", script.summarize, (i) => ({ summary: `Summary ${i}. Second sentence.` }));
        await emitJson(emit, value);
        return value;
      }),
    generateTags: () =>
      modelStream(async (emit) => {
        const value = await take("tags", script.generateTags, (i) => ({ tags: [`tag-${i}`, "alpha", "beta"] }));
        await emitJson(emit, value);
        return value;
      }),
    // Same defaults as the two calls above, so a test reads the same values whichever call produced them.
    summarizeAndTag: () =>
      modelStream(async (emit) => {
        const value = await take("summaryAndTags", script.summarizeAndTag, (i) => ({
          tags: [`tag-${i}`, "alpha", "beta"],
          summary: `Summary ${i}. Second sentence.`,
        }));
        await emitJson(emit, value);
        return value;
      }),
  };
  return { provider, calls };
}
