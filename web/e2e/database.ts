/**
 * The e2e run gets its own database, so it never touches the dev notebook or the server suite's.
 * ensure-database.ts creates and empties it; the server rebuilds the schema from server/drizzle at boot.
 */
export const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? "postgres://notes:notes@localhost:5432/notes_e2e";
