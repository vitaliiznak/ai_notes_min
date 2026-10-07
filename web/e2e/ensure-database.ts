import pg from "pg";
import { E2E_DATABASE_URL } from "./database";

const adminUrl = Object.assign(new URL(E2E_DATABASE_URL), { pathname: "/postgres" }).toString();
const databaseName = new URL(E2E_DATABASE_URL).pathname.slice(1);

async function run(connectionString: string, work: (client: pg.Client) => Promise<void>): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await work(client);
  } finally {
    await client.end();
  }
}

// Creates the e2e database if it is missing and empties it, so every run starts with no notes.
// Part of the webServer command, because the server applies the migrations when it boots.
await run(adminUrl, async (admin) => {
  const { rowCount } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [databaseName]);
  if (rowCount === 0) await admin.query(`CREATE DATABASE "${databaseName}"`);
});
await run(E2E_DATABASE_URL, async (client) => {
  await client.query("DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public");
});
console.log(`e2e database ready: ${databaseName}`);
