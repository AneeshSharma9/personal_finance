import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { supabaseAnonKey, supabaseUrl } from "@/lib/env";

/**
 * Supabase client bound to the request's cookies.
 *
 * Must be created per request (cookies() is request-scoped). Use
 * `getUser()` rather than `getSession()` for authorisation decisions - the
 * session cookie is unverified client-side, the user is validated against
 * Supabase Auth on every call.
 */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();

  return createServerClient(supabaseUrl(), supabaseAnonKey(), {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components cannot set cookies. This fires when Supabase
          // tries to refresh the session during a render. The proxy already
          // refreshes sessions, so swallowing it here is safe - it only means
          // "no cookie write happened on this render".
        }
      },
    },
  });
}