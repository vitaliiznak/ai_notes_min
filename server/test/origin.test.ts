import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { createPool } from "../src/db.js";
import { call, scriptedAi, startServer, TEST_DATABASE_URL, type TestServer } from "./helpers.js";

const pool = createPool(TEST_DATABASE_URL);
let servers: TestServer[] = [];
beforeEach(async () => { await pool.query("TRUNCATE notes"); });
afterEach(async () => { await Promise.all(servers.map((s) => s.close())); servers = []; });
afterAll(async () => { await pool.end(); });
async function serve() {
  const server = await startServer(pool, scriptedAi().provider);
  servers.push(server);
  return server;
}
async function seed() {
  const { rows } = await pool.query("INSERT INTO notes (title, content) VALUES ('Origin test', 'Test content') RETURNING id");
  return rows[0].id as string;
}

it("rejects cross-site authenticated-browser mutations", async () => {
  const server = await serve(); const id = await seed();
  expect((await call(server.url, "DELETE", `/api/notes/${id}`, undefined, { origin: "https://other.example" })).status).toBe(403);
  expect((await call(server.url, "POST", `/api/notes/${id}/tags`, undefined, { origin: "https://other.example" })).status).toBe(403);
  expect((await call(server.url, "GET", `/api/notes/${id}`)).status).toBe(200);
});

it("rejects a regenerate that omits Origin, and does not call the model", async () => {
  const ai = scriptedAi();
  const server = await startServer(pool, ai.provider);
  servers.push(server);
  const id = await seed();
  const res = await fetch(`${server.url}/api/notes/${id}/tags?regenerate=true`, { method: "POST" });
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({
    error: { code: "cross_site_request", message: "Cross-site changes are not allowed." },
  });
  expect(ai.calls.tags).toBe(0);
});
