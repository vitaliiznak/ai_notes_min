import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import {
  CONTENT_MAX,
  SUMMARY_MAX_CHARS,
  SUMMARY_MIN_CONTENT,
  SUMMARY_NOTE_DENOMINATOR,
  SUMMARY_NOTE_NUMERATOR,
  TAG_MAX_LENGTH,
  TAGS_MAX,
  TAGS_MIN,
  TITLE_MAX,
} from "./limits.js";

// The schema's single source. After changing it, run `npm run db:generate -w server` and commit the new migration.
// Limits are inlined as SQL literals: a CHECK cannot take query parameters.
const n = (value: number) => sql.raw(String(value));

// A CHECK cannot contain a subquery, so each tag position is spelled out.
const tagLengths = Array.from({ length: TAGS_MAX }, (_, i) => {
  const tag = `tags[${i + 1}]`;
  const fits = `char_length(${tag}) BETWEEN 1 AND ${TAG_MAX_LENGTH}`;
  return i < TAGS_MIN ? `${tag} IS NOT NULL AND ${fits}` : `(${tag} IS NULL OR ${fits})`;
}).join(" AND ");

export const notes = pgTable(
  "notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    summary: text("summary"),
    tags: text("tags").array(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    // The client's Idempotency-Key for the create request. Unique, so a repeated request stores no second note.
    idempotencyKey: uuid("idempotency_key").unique("notes_idempotency_key_key"),
  },
  (t) => [
    check("notes_title_chk", sql`char_length(title) BETWEEN 1 AND ${n(TITLE_MAX)}`),
    check("notes_content_chk", sql`char_length(content) BETWEEN 1 AND ${n(CONTENT_MAX)}`),
    check("notes_summary_min_content_chk", sql`summary IS NULL OR char_length(content) >= ${n(SUMMARY_MIN_CONTENT)}`),
    check("notes_summary_length_chk", sql`summary IS NULL OR char_length(summary) BETWEEN 1 AND ${n(SUMMARY_MAX_CHARS)}`),
    check(
      "notes_summary_shorter_chk",
      sql`summary IS NULL OR char_length(summary) * ${n(SUMMARY_NOTE_DENOMINATOR)} <= char_length(content) * ${n(SUMMARY_NOTE_NUMERATOR)}`,
    ),
    check("notes_tags_count_chk", sql`cardinality(tags) BETWEEN ${n(TAGS_MIN)} AND ${n(TAGS_MAX)}`),
    check("notes_tags_length_chk", sql.raw(`tags IS NULL OR (${tagLengths})`)),
    // NULLS FIRST is what a plain DESC sorts by, so the list query in repo.ts can read this index in order.
    index("notes_created_at_idx").on(t.createdAt.desc().nullsFirst(), t.id.desc().nullsFirst()),
  ],
);
