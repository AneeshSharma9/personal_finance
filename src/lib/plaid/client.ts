import "server-only";

import {
  Configuration,
  CountryCode,
  PlaidApi,
  PlaidEnvironments,
  Products,
} from "plaid";

import { plaidCredentials, plaidEnv } from "@/lib/env";

/**
 * Plaid client factory.
 *
 * Built lazily and cached per environment so the SDK is only constructed when
 * a Plaid call actually happens, and so credentials are read at call time
 * rather than at module load.
 */
const globalForPlaid = globalThis as unknown as {
  __financePlaid?: Map<string, PlaidApi>;
};

function clients(): Map<string, PlaidApi> {
  globalForPlaid.__financePlaid ??= new Map();
  return globalForPlaid.__financePlaid;
}

export function getPlaidClient(): PlaidApi {
  const env = plaidEnv();
  const cache = clients();

  const cached = cache.get(env);
  if (cached) return cached;

  const { clientId, secret } = plaidCredentials();
  const configuration = new Configuration({
    basePath: PlaidEnvironments[env],
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": clientId,
        "PLAID-SECRET": secret,
        "Plaid-Version": "2020-09-14",
      },
      // 30s keeps a hung Plaid call from pinning a serverless invocation.
      timeout: 30_000,
    },
  });

  const client = new PlaidApi(configuration);
  cache.set(env, client);
  return client;
}

/**
 * Products requested on a new Link token.
 *
 * `transactions` is the only required product. Liabilities and Investments are
 * requested as OPTIONAL so an institution that doesn't support them can still
 * link - required would make those institutions fail outright.
 *
 * This set is chosen to match the Plaid Trial bundle: Transactions, Balance,
 * Auth, Identity, Assets, Liabilities, Investments, Statements (section 2).
 */
export const LINK_PRODUCTS: Products[] = [Products.Transactions];

export const LINK_OPTIONAL_PRODUCTS: Products[] = [
  Products.Liabilities,
  Products.Investments,
];

/** Plaid Link is US-only. */
export const LINK_COUNTRY_CODES: CountryCode[] = [CountryCode.Us];

/**
 * Turn a Plaid SDK error into something safe to log and show.
 *
 * Plaid errors carry the request body in some cases, so we never pass
 * `error.response.data` through - it can contain institution credentials.
 */
export function describePlaidError(error: unknown): {
  errorType: string;
  errorCode: string;
  message: string;
  status: number | null;
} {
  const e = error as {
    response?: { status?: number; data?: { error_type?: string; error_code?: string; error_message?: string } };
    status?: number;
  };

  return {
    errorType: e.response?.data?.error_type ?? "UNKNOWN_ERROR",
    errorCode: e.response?.data?.error_code ?? "unknown",
    message: e.response?.data?.error_message ?? "Plaid request failed.",
    status: e.response?.status ?? e.status ?? null,
  };
}

/**
 * Redact a Plaid access token for logging.
 *
 * Access tokens are bearer credentials. Show only enough to correlate with
 * Plaid's own logs.
 */
export function redactToken(token: string): string {
  return `access-sandbox-****${token.slice(-4)}`;
}