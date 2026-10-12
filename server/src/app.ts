import express, { type Express, type Request, type RequestHandler } from "express";
import type pg from "pg";
import type { AiProvider } from "./ai/provider.js";
import { errorHandler, HttpError } from "./errors.js";
import { createEnricher } from "./notes/enrichment.js";
import { createNotesRepo } from "./notes/repo.js";
import { notesRouter } from "./notes/routes.js";

interface AppDeps {
  pool: pg.Pool;
  ai: AiProvider;
  staticDir?: string;
}

export interface App {
  app: Express;
  /** Resolves once no AI call is running, including those a new note started after its response. */
  idle: () => Promise<void>;
}

function isSameOrigin(req: Request): boolean {
  try {
    return new URL(req.get("origin") ?? "").host === req.get("host");
  } catch {
    return false; // missing or malformed Origin
  }
}

// Browsers cache Basic credentials at the gateway. Allow a mutation only when
// Origin's host is this host. A missing Origin is not same-origin: a script
// can omit it and loop ?regenerate=true against the AI key.
const rejectCrossSiteMutations: RequestHandler = (req, _res, next) => {
  const mutation = !["GET", "HEAD", "OPTIONS"].includes(req.method);
  if (mutation && (!isSameOrigin(req) || req.get("sec-fetch-site") === "cross-site")) {
    throw new HttpError(403, "cross_site_request", "Cross-site changes are not allowed.");
  }
  next();
};

export function createApp({ pool, ai, staticDir }: AppDeps): App {
  const app = express();
  app.disable("x-powered-by");
  app.use(rejectCrossSiteMutations);
  app.use(express.json({ limit: "256kb" }));

  app.get("/api/health", async (_req, res) => {
    try {
      await pool.query("SELECT 1");
    } catch (err) {
      console.error("Database health check failed:", err instanceof Error ? err.message : err);
      throw new HttpError(503, "database_unavailable", "The database is not available.");
    }
    res.json({ status: "ok" });
  });

  const repo = createNotesRepo(pool);
  const enricher = createEnricher(repo, ai);
  app.use("/api", notesRouter(repo, enricher));
  app.use("/api", () => {
    throw new HttpError(404, "not_found", "Route not found.");
  });

  // Production: one process serves the built SPA too (hash routing, so no fallback route is needed).
  if (staticDir) app.use(express.static(staticDir));

  app.use(errorHandler);
  return { app, idle: enricher.idle };
}
