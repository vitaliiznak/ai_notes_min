import express, { type Express } from "express";
import type pg from "pg";
import type { AiProvider } from "./ai/provider.js";
import { errorHandler, HttpError } from "./errors.js";
import { createEnricher } from "./notes/enrichment.js";
import { createNotesRepo } from "./notes/repo.js";
import { notesRouter } from "./notes/routes.js";
import { openApiDocument } from "./openapi.js";

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

export function createApp({ pool, ai, staticDir }: AppDeps): App {
  const app = express();
  app.disable("x-powered-by");
  // Browsers cache Basic credentials at the gateway. Reject cross-site mutations
  // so another website cannot spend AI calls or change this shared notebook.
  app.use((req, _res, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.get("origin");
      let sameOrigin = !origin;
      try { if (origin) sameOrigin = new URL(origin).host === req.get("host"); } catch { sameOrigin = false; }
      if (!sameOrigin || req.get("sec-fetch-site") === "cross-site") {
        throw new HttpError(403, "cross_site_request", "Cross-site changes are not allowed.");
      }
    }
    next();
  });
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

  app.get("/api/openapi.json", (_req, res) => {
    res.json(openApiDocument());
  });

  const repo = createNotesRepo(pool);
  const enrich = createEnricher(repo, ai);
  app.use("/api", notesRouter(repo, enrich));
  app.use("/api", () => {
    throw new HttpError(404, "not_found", "Route not found.");
  });

  // Production: one process serves the built SPA too (hash routing, so no fallback route is needed).
  if (staticDir) app.use(express.static(staticDir));

  app.use(errorHandler);
  return { app, idle: enrich.idle };
}
