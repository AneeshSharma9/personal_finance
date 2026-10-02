import "server-only";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

/**
 * Postgres connection, created on first use rather than at import time.
 *
 * Lazy creation matters for the build: Next.js evaluates route modules while
 * collecting page data, and a missing DATABASE_URL there should not fail the
 * whole build before the app has ever run.
 *
 * The client is cached on globalThis so dev hot-reloads reuse one pool instead
 * of leaking a new one per reload.
 */
const globalForDb = globalThis as unknown as {
  __financeSql?: postgres.Sql;
  __financeDb?: ReturnType<typeof drizzle<typeof schema>>;
};

function createPool() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "Missing required environment variable DATABASE_URL. See .env.example.",
    );
  }

  return postgres(url, {
    /*
     * Kept small deliberately. More than one pool exists per running server -
     * the app bundle and the SSR bundle each get their own module registry, so
     * the globalThis cache above does not dedupe across them. With 10 each, two
     * servers meant 20 connections and the session pooler refused them all.
     * Against the transaction pooler this is no longer a hard cap, but there is
     * no reason to hold idle backend connections.
     */
    max: 4,
    // Supabase's pooled connections go through pgbouncer in transaction mode,
    // which does not support prepared statements.
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
  });
}

function database() {
  if (!globalForDb.__financeSql) {
    globalForDb.__financeSql = createPool();
  }
  if (!globalForDb.__financeDb) {
    globalForDb.__financeDb = drizzle(globalForDb.__financeSql, { schema });
  }
  return globalForDb.__financeDb;
}

/**
 * Proxy so `db.select()` etc. work at module scope while still connecting
 * lazily on first property access.
 */
export const db: ReturnType<typeof drizzle<typeof schema>> =
  new Proxy({} as ReturnType<typeof drizzle<typeof schema>>, {
    get(_target, prop, receiver) {
      const instance = database();
      const value = Reflect.get(instance as object, prop, receiver);
      return typeof value === "function" ? value.bind(instance) : value;
    },
  });

export * as tables from "./schema";
export { toNumber } from "./schema";