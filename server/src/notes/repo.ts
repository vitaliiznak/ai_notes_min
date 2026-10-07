import { and, desc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";
import type { Note, NoteListItem } from "./limits.js";
import type { CreateNoteInput } from "./schema.js";
import { notes } from "./table.js";

function listed(row: { id: string; title: string; tags: string[] | null; createdAt: Date }): NoteListItem {
  return {
    id: row.id,
    title: row.title,
    tags: row.tags,
    createdAt: row.createdAt.toISOString(),
  };
}

function toNote(row: typeof notes.$inferSelect): Note {
  return { ...listed(row), content: row.content, summary: row.summary };
}

export type NotesRepo = ReturnType<typeof createNotesRepo>;

export function createNotesRepo(pool: pg.Pool) {
  const db = drizzle({ client: pool });

  async function get(id: string): Promise<Note | null> {
    const [row] = await db.select().from(notes).where(eq(notes.id, id));
    return row ? toNote(row) : null;
  }

  /**
   * Stores an AI result. Without `overwrite` only an empty field is written,
   * so concurrent writers (e.g. two server processes) converge on the first
   * stored value. Returns the note as it is after the attempt.
   */
  async function saveAiResult(
    id: string,
    write: { summary: string } | { tags: string[] },
    overwrite: boolean,
  ): Promise<Note | null> {
    const column = "summary" in write ? notes.summary : notes.tags;
    const [row] = await db
      .update(notes)
      .set(write)
      .where(overwrite ? eq(notes.id, id) : and(eq(notes.id, id), isNull(column)))
      .returning();
    return row ? toNote(row) : get(id);
  }

  return {
    get,

    async list(): Promise<NoteListItem[]> {
      const rows = await db
        .select({ id: notes.id, title: notes.title, tags: notes.tags, createdAt: notes.createdAt })
        .from(notes)
        .orderBy(desc(notes.createdAt), desc(notes.id));
      return rows.map(listed);
    },

    /**
     * Inserts a note. When the idempotency key is already taken, returns the note stored under
     * it with `created: false`. The unique index makes a concurrent insert with the same key
     * wait for the first one to commit, so exactly one row is stored.
     */
    async create(input: CreateNoteInput, idempotencyKey?: string): Promise<{ note: Note; created: boolean }> {
      const [row] = await db
        .insert(notes)
        .values({ title: input.title, content: input.content, idempotencyKey })
        .onConflictDoNothing({ target: notes.idempotencyKey })
        .returning();
      if (row) return { note: toNote(row), created: true };
      // Only a key can conflict, so one is set here.
      const [existing] = idempotencyKey
        ? await db.select().from(notes).where(eq(notes.idempotencyKey, idempotencyKey))
        : [];
      if (!existing) throw new Error("Insert returned no row.");
      return { note: toNote(existing), created: false };
    },

    // DELETE ... RETURNING is atomic: concurrent deletions cannot both report a row.
    async remove(id: string): Promise<boolean> {
      const rows = await db.delete(notes).where(eq(notes.id, id)).returning({ id: notes.id });
      return rows.length === 1;
    },

    async removeAll(): Promise<number> {
      const rows = await db.delete(notes).returning({ id: notes.id });
      return rows.length;
    },

    saveAiResult,
  };
}
