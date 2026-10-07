import { readFileSync } from "node:fs";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, migrateSchema } from "../src/db.js";
import { CONTENT_MAX, SUMMARY_MAX_CHARS, SUMMARY_MIN_CONTENT, TAG_MAX_LENGTH, TITLE_MAX } from "../src/notes/limits.js";
import { TEST_DATABASE_URL, withAdmin } from "./helpers.js";

const dbName = "notes_empty";
const emptyUrl = Object.assign(new URL(TEST_DATABASE_URL), { pathname: `/${dbName}` }).toString();

async function dropEmpty() {
  await withAdmin(async (admin) => {
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [
      dbName,
    ]);
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  });
}

// Every migration in server/drizzle, as listed in Drizzle's journal.
const MIGRATIONS: number = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8")).entries.length;

const appliedMigrations = async (pool: pg.Pool) =>
  (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations")).rows[0]!.n;

describe("migrateSchema", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    await dropEmpty();
    await withAdmin((admin) => admin.query(`CREATE DATABASE "${dbName}"`));
    pool = createPool(emptyUrl);
  });

  afterAll(async () => {
    await pool.end();
    await dropEmpty();
  });

  // Three replicas starting at once against an empty database. Without the advisory lock they
  // race to create the same tables and the losers fail.
  it("migrates an empty database once when three processes start at the same time", async () => {
    const pools = [createPool(emptyUrl), createPool(emptyUrl), createPool(emptyUrl)];
    try {
      const results = await Promise.allSettled(pools.map((p) => migrateSchema(p)));

      expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
      expect(await appliedMigrations(pool)).toBe(MIGRATIONS);
    } finally {
      await Promise.all(pools.map((p) => p.end()));
    }
  });

  it("creates the notes table, its list index and its checks", async () => {
    const index = await pool.query(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'notes_created_at_idx'",
    );
    expect(index.rows).toEqual([{ indexdef: expect.stringContaining("created_at DESC, id DESC") }]);

    const tags = ["a".repeat(TAG_MAX_LENGTH), "beta", "gamma"];
    const stored = await pool.query("INSERT INTO notes (title, content, tags) VALUES ('Limits', 'Tag length.', $1) RETURNING tags", [
      tags,
    ]);
    expect(stored.rows[0].tags).toEqual(tags);
    await expect(
      pool.query("INSERT INTO notes (title, content, tags) VALUES ('Limits', 'Tag length.', $1)", [
        ["a".repeat(TAG_MAX_LENGTH + 1), "beta", "gamma"],
      ]),
    ).rejects.toMatchObject({ code: "23514", constraint: "notes_tags_length_chk" });
    await expect(pool.query("INSERT INTO notes (title, content) VALUES ($1, 'x')", ["t".repeat(TITLE_MAX + 1)])).rejects.toMatchObject({
      code: "23514",
      constraint: "notes_title_chk",
    });
    await expect(
      pool.query("INSERT INTO notes (title, content) VALUES ('x', $1)", ["c".repeat(CONTENT_MAX + 1)]),
    ).rejects.toMatchObject({ code: "23514", constraint: "notes_content_chk" });
    await expect(pool.query("INSERT INTO notes (title, content, tags) VALUES ('None', 'No tags.', '{}')")).rejects.toMatchObject({
      code: "23514",
      constraint: "notes_tags_count_chk",
    });
    await pool.query("INSERT INTO notes (title, content, tags) VALUES ('One', 'One tag.', $1)", [["only"]]);
    await expect(
      pool.query("INSERT INTO notes (title, content, tags) VALUES ('Six', 'Too many.', $1)", [["a", "b", "c", "d", "e", "f"]]),
    ).rejects.toMatchObject({ code: "23514", constraint: "notes_tags_count_chk" });
  });

  it("rejects a summary that is over the cap or not at least 20% shorter than the note", async () => {
    const long = "c".repeat(2_000);
    await pool.query("INSERT INTO notes (title, content, summary) VALUES ('Ok', $1, $2)", [long, "s".repeat(SUMMARY_MAX_CHARS)]);
    await expect(
      pool.query("INSERT INTO notes (title, content, summary) VALUES ('Cap', $1, $2)", [long, "s".repeat(SUMMARY_MAX_CHARS + 1)]),
    ).rejects.toMatchObject({ code: "23514", constraint: "notes_summary_length_chk" });
    const atMinimum = "c".repeat(SUMMARY_MIN_CONTENT);
    await pool.query("INSERT INTO notes (title, content, summary) VALUES ('Eighty', $1, $2)", [atMinimum, "s".repeat(400)]);
    await expect(
      pool.query("INSERT INTO notes (title, content, summary) VALUES ('Over', $1, $2)", [atMinimum, "s".repeat(401)]),
    ).rejects.toMatchObject({ code: "23514", constraint: "notes_summary_shorter_chk" });
  });

  it("stores a summary only on a note of at least the summary minimum length", async () => {
    const insert = (content: string) =>
      pool.query("INSERT INTO notes (title, content, summary) VALUES ('Short', $1, 'A summary.')", [content]);

    await insert("😀".repeat(SUMMARY_MIN_CONTENT));
    await expect(insert("c".repeat(SUMMARY_MIN_CONTENT - 1))).rejects.toMatchObject({
      code: "23514",
      constraint: "notes_summary_min_content_chk",
    });
  });

  it("allows one note per idempotency key", async () => {
    const key = "6f1c2c1e-8a4b-4c3e-9f0a-1b2c3d4e5f60";
    await pool.query("INSERT INTO notes (title, content, idempotency_key) VALUES ('Once', 'body', $1)", [key]);

    await expect(
      pool.query("INSERT INTO notes (title, content, idempotency_key) VALUES ('Twice', 'body', $1)", [key]),
    ).rejects.toMatchObject({ code: "23505", constraint: "notes_idempotency_key_key" });
  });

  it("applies nothing and keeps the rows when the database is already migrated", async () => {
    const inserted = await pool.query("INSERT INTO notes (title, content) VALUES ('keep', 'body') RETURNING id");

    await migrateSchema(pool);

    expect(await appliedMigrations(pool)).toBe(MIGRATIONS);
    const found = await pool.query("SELECT title FROM notes WHERE id = $1", [inserted.rows[0].id]);
    expect(found.rows).toEqual([{ title: "keep" }]);
  });
});
