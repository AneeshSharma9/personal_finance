import "server-only";

import { cookies } from "next/headers";

/**
 * Whether balances are currently hidden.
 *
 * A cookie rather than `localStorage`, which is the unusual choice and the load-
 * bearing one. The theme can live in `localStorage` because the worst case there
 * is a flash of the wrong *colours*. Here the worst case is the opposite: with
 * the preference in `localStorage`, the server cannot know it, so it renders the
 * real figures, they sit in the HTML and the RSC payload, and they are on screen
 * until the client hydrates and masks them. For a screen share that is the whole
 * window the feature exists to close - and it would reopen every reload.
 *
 * With the preference in a cookie the server renders asterisks in the first
 * paint, so there is nothing real to leak and nothing to flash. The cost is that
 * toggling is a round trip and a re-render rather than a local state change,
 * which for a deliberate privacy action is the right trade: it should feel like
 * it took effect, not like a flick.
 *
 * Read through `cookies()` on each page rather than cached in a module variable,
 * because the pages are server-rendered per request and a cached boolean would
 * outlive the cookie.
 */

/** The cookie name. Short, and namespaced to this app. */
export const HIDDEN_BALANCES_COOKIE = "hide_balances";

/**
 * A year. Long enough that the preference is a habit rather than something to
 * re-set, short enough that a shared or borrowed device stops remembering it.
 */
const MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export async function balancesHidden(): Promise<boolean> {
  const store = await cookies();
  return store.get(HIDDEN_BALANCES_COOKIE)?.value === "1";
}

/**
 * The `Set-Cookie` options for the route that writes this preference.
 *
 * `httpOnly` so a script cannot read it back and learn that balances are hidden -
 * the mask is not a secret, but the preference is a small thing that says the
 * person using this device may be hiding something, and there is no reason to
 * expose it. `sameSite: "lax"` because the write is a same-site POST and there is
 * no reason to loosen it; `secure` so it never travels in cleartext.
 *
 * Not a `__Host-` prefix: that requires `path=/` with no `domain`, which is fine,
 * but the name would then be constrained by the browser in a way that is worth
 * spending the character on only if something can set this cookie from another
 * origin. Nothing can.
 */
export const hiddenBalancesCookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: MAX_AGE_SECONDS,
} as const;