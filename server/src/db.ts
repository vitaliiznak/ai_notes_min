import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 10 });
}

// server/drizzle, from both src/db.ts and dist/db.js.
const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
// Any fixed number. It names the lock, so two processes starting at once take turns.
const MIGRATION_LOCK = 7_411_032;

/**
 * Applies the migrations in server/drizzle that this database has not run yet, each in a transaction.
 * Drizzle records them in drizzle.__drizzle_migrations.
 */
export async function migrateSchema(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    await migrate(drizzle({ client }), { migrationsFolder });
  } finally {
    // Closing the session releases the lock, also when a migration failed.
    client.release(true);
  }
}
