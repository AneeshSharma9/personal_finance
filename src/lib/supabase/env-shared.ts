/**
 * Env vars that are safe in the browser. The Supabase anon key is designed to
 * ship to clients; the email allowlist is what protects the data.
 *
 * Kept separate from env.ts, which is `server-only`.
 *
 * IMPORTANT: each variable must be read as a literal `process.env.NEXT_PUBLIC_*`
 * expression. Next.js inlines those at build time by substituting the exact text
 * of the property access, so a dynamic lookup like `process.env[name]` silently
 * becomes undefined in the browser bundle. This is the only module allowed to
 * read public env vars, which keeps the literal-access requirement in one file.
 */
export function supabaseUrl(): string {
  const value = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!value) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL. Add it to .env.local and restart the " +
        "dev server. See .env.example.",
    );
  }
  return value;
}

export function supabaseAnonKey(): string {
  const value = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!value) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_ANON_KEY. Add it to .env.local and " +
        "restart the dev server. See .env.example.",
    );
  }
  return value;
}