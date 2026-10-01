import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Session refresh and route protection.
 *
 * In Next.js 16 this file is `proxy.ts` with a `proxy` export (the old
 * `middleware.ts` / `middleware` naming is deprecated). It runs on the Node.js
 * runtime only; the `runtime` config option is not available here.
 *
 * Two jobs:
 *   1. Refresh the Supabase session cookie, which must happen here rather than
 *      in a Server Component because components cannot set cookies.
 *   2. Redirect signed-out users away from app pages.
 *
 * This is a convenience layer, NOT the security boundary. Every API route and
 * data query independently re-checks the session and the email allowlist,
 * because proxy can be bypassed and server functions are not separate routes.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // getUser() validates against Supabase Auth; getSession() would only decode
  // the cookie, which the client controls.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  // API routes must not be redirected. They enforce their own auth and return a
  // real status code (401/403/404) with a JSON body. Redirecting them to /login
  // would send a fetch() an HTML page, and break client code that checks
  // response.ok or parses JSON. The session refresh above still applies, so they
  // see a fresh cookie.
  if (pathname.startsWith("/api/")) {
    return response;
  }

  const isLogin = pathname === "/login";

  if (!user && !isLogin) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    // Preserve where they were headed so login can bounce them back.
    if (pathname !== "/") {
      url.searchParams.set("next", pathname);
    }
    return NextResponse.redirect(url);
  }

  if (user && isLogin) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  /**
   * Everything except Next internals, the Plaid webhook, and static files.
   *
   * Generated routes like /manifest.webmanifest and /icon are excluded below.
   *
   * `/api/plaid/webhook` is excluded because Plaid posts there with no session
   * cookie; it verifies its own signed JWT instead.
   */
  matcher: [
    "/((?!api/plaid/webhook|_next/static|_next/image|favicon.ico|manifest.webmanifest|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};