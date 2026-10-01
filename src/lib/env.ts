/**
 * Central env access.
 *
 * Everything Plaid- or Supabase-related is server-only. Importing this from a
 * client component is a build error, not a runtime surprise.
 *
 * Plaid credentials are read lazily from a pair of env vars selected by
 * PLAID_ENV, so both Sandbox and Production keys can live in the same
 * environment and switching is a one-line change.
 */
import "server-only";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. See .env.example.`,
    );
  }
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

export type PlaidEnv = "sandbox" | "production";

export function plaidEnv(): PlaidEnv {
  const value = process.env.PLAID_ENV ?? "sandbox";
  if (value !== "sandbox" && value !== "production") {
    throw new Error(
      `PLAID_ENV must be "sandbox" or "production", got "${value}".`,
    );
  }
  return value;
}

export function plaidCredentials(): { clientId: string; secret: string } {
  const env = plaidEnv();
  return {
    clientId: required(
      env === "sandbox" ? "PLAID_SANDBOX_CLIENT_ID" : "PLAID_PRODUCTION_CLIENT_ID",
    ),
    secret: required(
      env === "sandbox" ? "PLAID_SANDBOX_SECRET" : "PLAID_PRODUCTION_SECRET",
    ),
  };
}

/** Plaid only accepts HTTPS webhook/redirect URLs in production. */
export function plaidWebhookUrl(): string | undefined {
  return optional("PLAID_WEBHOOK_URL");
}

/**
 * OAuth redirect URI, or undefined when not configured.
 *
 * Deliberately NO fallback to the request origin. `redirect_uri` is only needed
 * by OAuth institutions, and Plaid rejects the whole /link/token/create call
 * with INVALID_FIELD unless the value is one it has registered. Sending an
 * unregistered origin (e.g. http://localhost:3000) breaks linking for every
 * institution, including the non-OAuth ones that never needed it.
 *
 * So: omit the field unless PLAID_REDIRECT_URI is set to a registered HTTPS URL,
 * and OAuth banks will ask for it later. See plaid.com/docs/link/oauth.
 */
export function plaidRedirectUri(): string | undefined {
  return optional("PLAID_REDIRECT_URI");
}

/**
 * Days of history requested on the FIRST sync of an Item.
 *
 * Plaid only honours this when an Item is first initialized with Transactions,
 * so this value is effectively permanent for that Item. On the Trial plan you
 * cannot fix it afterwards without spending another slot.
 */
export function plaidDaysRequested(): number {
  const raw = process.env.PLAID_DAYS_REQUESTED;
  if (!raw) return 730;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 730;
  // Plaid's documented ceiling.
  return Math.min(parsed, 730);
}

export function databaseUrl(): string {
  return required("DATABASE_URL");
}

export function supabaseUrl(): string {
  return required("NEXT_PUBLIC_SUPABASE_URL");
}

/**
 * Note: no service-role key.
 *
 * Every Supabase call in this app is `auth.getUser()`, `signInWithPassword`, or
 * `signOut`, all of which work with the anon key. All app data is read and
 * written through Drizzle over DATABASE_URL, not through Supabase's PostgREST
 * API, so RLS never applies to it and the service-role key is not needed.
 * Adding one would only create a secret that bypasses auth if it leaked.
 */
export function supabaseAnonKey(): string {
  return required("NEXT_PUBLIC_SUPABASE_ANON_KEY");
}

/**
 * AES-256-GCM key for Plaid access tokens.
 *
 * Rotating this makes every stored token undecryptable, which means losing
 * every linked Item and its Trial-plan slot. Back it up alongside the database.
 */
export function tokenEncryptionKey(): Buffer {
  const raw = required("TOKEN_ENCRYPTION_KEY");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY must be 32 random bytes, base64 encoded " +
        `(decoded length was ${key.length}). Generate one with: ` +
        'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }
  return key;
}

export function allowedEmails(): Set<string> {
  const raw = optional("ALLOWED_EMAILS");
  if (!raw) {
    throw new Error(
      "ALLOWED_EMAILS is not set. Set it to your own email so nobody else can " +
        "sign up and consume your Plaid 10-Item cap.",
    );
  }
  return new Set(
    raw
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isAllowedEmail(email: string): boolean {
  try {
    return allowedEmails().has(email.trim().toLowerCase());
  } catch {
    return false;
  }
}

/** Shared secret guarding the net-worth snapshot cron endpoint. */
export function cronSecret(): string | undefined {
  return optional("CRON_SECRET");
}