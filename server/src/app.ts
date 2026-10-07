import express, { type Express, type Request, type Response } from "express";
import type pg from "pg";
import type { AiProvider } from "./ai/provider.js";
import { errorHandler, HttpError } from "./errors.js";
import { createEnricher } from "./notes/enrichment.js";
import { createNotesRepo } from "./notes/repo.js";
import { notesRouter } from "./notes/routes.js";
import { openApiDocument, serverUrlFromRequest } from "./openapi.js";

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
  // Browsers cache Basic credentials at the gateway. Allow a mutation only when
  // Origin's host is this host. A missing Origin is not same-origin: a script
  // can omit it and loop ?regenerate=true against the AI key.
  app.use((req, _res, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.get("origin");
      let sameOrigin = false;
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

  // Documentation sites (and a local page opened from another origin) fetch this file in the browser.
  const allowOpenApiFetch = (req: Request, res: Response) => {
    res.set("access-control-allow-origin", "*");
    if (req.get("access-control-request-private-network") === "true") {
      res.set("access-control-allow-private-network", "true");
    }
  };
  app.options("/api/openapi.json", (req, res) => {
    allowOpenApiFetch(req, res);
    res.set("access-control-allow-methods", "GET, OPTIONS");
    const requested = req.get("access-control-request-headers");
    if (requested) res.set("access-control-allow-headers", requested);
    res.sendStatus(204);
  });
  app.get("/api/openapi.json", (req, res) => {
    allowOpenApiFetch(req, res);
    res.json(openApiDocument(serverUrlFromRequest(req)));
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
