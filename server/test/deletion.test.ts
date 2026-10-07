import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { createPool } from "../src/db.js";
import { call, LONG_NOTE, scriptedAi, startServer, TEST_DATABASE_URL, type TestServer } from "./helpers.js";

const pool = createPool(TEST_DATABASE_URL);
let servers: TestServer[] = [];
beforeEach(async () => { await pool.query("TRUNCATE notes"); });
afterEach(async () => { await Promise.all(servers.map((s) => s.close())); servers = []; });
afterAll(async () => { await pool.end(); });
async function serve(delayMs = 0) {
  const server = await startServer(pool, scriptedAi({ delayMs }).provider);
  servers.push(server);
  return server;
}
async function seed() {
  const { rows } = await pool.query("INSERT INTO notes (title, content) VALUES ('Delete test', 'Test content') RETURNING id");
  return rows[0].id as string;
}

it("deletes only the selected note and returns 404 on a repeat", async () => {
  const server = await serve();
  const id = await seed();
  const other = await seed();
  expect(await call(server.url, "DELETE", `/api/notes/${id}`)).toEqual({ status: 200, body: { deleted: 1 } });
  expect((await call(server.url, "DELETE", `/api/notes/${id}`)).status).toBe(404);
  expect((await call(server.url, "GET", `/api/notes/${other}`)).status).toBe(200);
});

it("reports one deletion for concurrent individual deletes across two instances", async () => {
  const a = await serve(); const b = await serve(); const id = await seed();
  const responses = await Promise.all(Array.from({ length: 10 }, (_, n) => call(n % 2 ? a.url : b.url, "DELETE", `/api/notes/${id}`)));
  expect(responses.map((r) => r.status).sort()).toEqual([200, ...Array(9).fill(404)]);
  expect((await call(a.url, "GET", `/api/notes/${id}`)).status).toBe(404);
});

it("counts each note once for concurrent delete-all requests across two instances", async () => {
  const a = await serve(); const b = await serve();
  await Promise.all(Array.from({ length: 5 }, seed));
  const responses = await Promise.all(Array.from({ length: 10 }, (_, n) => call(n % 2 ? a.url : b.url, "DELETE", "/api/notes")));
  expect(responses.map((r) => r.status)).toEqual(Array(10).fill(200));
  expect(responses.reduce((n, r) => n + r.body.deleted, 0)).toBe(5);
  expect((await call(a.url, "GET", "/api/notes")).body.notes).toEqual([]);
});

it.each(["individual", "all"])("does not recreate a note when AI finishes after %s deletion", async (scope) => {
  const server = await serve(200);
  const created = await call(server.url, "POST", "/api/notes", LONG_NOTE);
  const id = created.body.note.id;
  const path = scope === "all" ? "/api/notes" : `/api/notes/${id}`;
  expect((await call(server.url, "DELETE", path)).body).toEqual({ deleted: 1 });
  await server.idle();
  expect((await call(server.url, "GET", "/api/notes")).body.notes).toEqual([]);
});

it("rejects cross-site authenticated-browser mutations", async () => {
  const server = await serve(); const id = await seed();
  expect((await call(server.url, "DELETE", `/api/notes/${id}`, undefined, { origin: "https://other.example" })).status).toBe(403);
  expect((await call(server.url, "POST", `/api/notes/${id}/tags`, undefined, { origin: "https://other.example" })).status).toBe(403);
  expect((await call(server.url, "GET", `/api/notes/${id}`)).status).toBe(200);
});
