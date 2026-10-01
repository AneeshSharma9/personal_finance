import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

import { defineConfig } from "drizzle-kit";

/**
 * Migrations are generated from the schema and applied over a direct Postgres
 * connection, so you don't need the Supabase CLI. To apply the generated SQL by
 * hand instead, paste drizzle/*.sql into Supabase's SQL editor.
 *
 *   npm run db:generate   # write a migration from schema changes
 *   npm run db:migrate    # apply pending migrations
 *   npm run db:studio     # browse synced data
 *
 * `drizzle-kit` loads only `.env`, but this project keeps its secrets in
 * `.env.local` (which is what Next.js reads). Without the load below,
 * DATABASE_URL arrives here as undefined and the CLI fails with `url: ''`.
 * `.env` wins if present, so CI can override without touching your local file.
 */
for (const file of [".env", ".env.local"]) {
  if (existsSync(file)) {
    loadEnvFile(file);
  }
}

const url = process.env.DATABASE_URL;

if (!url) {
  throw new Error(
    "DATABASE_URL is not set. Add it to .env.local (see .env.example) before " +
      "running migrations.",
  );
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url },
  strict: true,
  verbose: true,
});