import { createPool, migrateSchema } from "../src/db.js";
import { TEST_DATABASE_URL, withAdmin } from "./helpers.js";

/** Creates the test database if needed and rebuilds it from the migrations on every run. */
export default async function setup() {
  const dbName = new URL(TEST_DATABASE_URL).pathname.slice(1);
  await withAdmin(async (admin) => {
    const { rowCount } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    if (rowCount === 0) await admin.query(`CREATE DATABASE "${dbName}"`);
  });
  const pool = createPool(TEST_DATABASE_URL);
  try {
    await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await migrateSchema(pool);
  } finally {
    await pool.end();
  }
}
