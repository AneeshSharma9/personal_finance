import Link from "next/link";

import { DesktopNav, MobileNav } from "@/components/nav";
import { UserMenu } from "@/components/user-menu";

/**
 * App shell.
 *
 * On `md` and up the viewport is split into a fixed sidebar and a scrolling main
 * column: only the page content scrolls, so the navigation and the user control
 * stay put. `min-h-0` on the column and main is what lets `overflow-y-auto` scroll
 * rather than expand.
 *
 * The wrapper is `md:fixed md:inset-0` rather than a `100dvh` box, and that is the
 * whole trick. Sizing it in viewport units looks equivalent and is not:
 *
 *  - `100vh` and `100dvh` measure the viewport *including* any horizontal
 *    scrollbar, while the document's own height excludes it, so a wrapper sized in
 *    those units can come out taller than the space available.
 *  - The symptom is nothing like "the layout is a bit tall". The page grows a
 *    second scrollbar beside the content one, and scrolling that one moves the
 *    sidebar up and reveals empty space below the footer.
 *
 * `fixed` + `inset-0` takes the shell out of the document's flow entirely, so the
 * document has no height to scroll and `overflow-hidden` clips anything inside. No
 * child can bring the second scrollbar back, which arithmetic on viewport units
 * never actually guarantees.
 *
 * Two things stop that from leaking a second scrollbar onto the document, which is
 * what "the page scrolls and the sidebar goes with it" looks like:
 *
 *  - `overscroll-contain` on both the shell and main, so reaching the end of the
 *    transaction list cannot chain the gesture on to the document. Without it,
 *    scrolling to the bottom of a long list hands the remaining movement to the
 *    page, and the sidebar moves up with it.
 *  - `overflow-x-clip` on main. `overflow-y: auto` computes `overflow-x` to `auto`
 *    too, so content even slightly wider than the column would add a second bar
 *    nobody asked for. `clip` is the one value that does not force the other axis,
 *    so it removes that without giving up the vertical scroll.
 *
 * `fixed` re-parents `position: fixed` descendants, so the Toast becomes relative to
 * the shell rather than the viewport. At `md` those are the same box, so nothing
 * moves; the mobile tab bar is `md:hidden` and never sees it.
 *
 * Below `md` the document scrolls normally, which behaves better on iOS than
 * nesting a scroller, and the bottom tab bar is `fixed` anyway.
 */
export function AppShell({
  children,
  email,
  signOut,
}: {
  children: React.ReactNode;
  email: string | null;
  signOut: React.ReactNode;
}) {
  return (
    <div className="md:fixed md:inset-0 md:flex md:overflow-hidden md:overscroll-contain">
      <aside className="hidden border-r border-neutral-200 md:flex md:w-60 md:shrink-0 md:flex-col md:overflow-y-auto md:overscroll-contain p-4 dark:border-neutral-800">
        <Link href="/" className="mb-6 block text-lg font-semibold">
          Finance
        </Link>

        <DesktopNav />

        {/*
          mt-auto pins this to the bottom of the viewport, because the aside is
          stretched to the full height of the inset-0 container.
        */}
        <div className="mt-auto border-t border-neutral-200 pt-3 dark:border-neutral-800">
          <UserMenu email={email} signOut={signOut} />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col md:min-h-0 md:overflow-hidden">
        <header className="flex items-center justify-between gap-3 border-b border-neutral-200 px-4 py-2 md:hidden dark:border-neutral-800">
          <Link href="/" className="min-w-0 truncate text-base font-semibold">
            Finance
          </Link>
          {/* Right-aligned, capped so a long email cannot push the logo off
              screen. Opens downward: this header is at the top of the page. */}
          <div className="w-40 shrink-0">
            <UserMenu
              email={email}
              signOut={signOut}
              placement="bottom"
            />
          </div>
        </header>

        {/* The only scrolling region from `md` up. Bottom padding clears the
            fixed tab bar and the iPhone home indicator below `md`. */}
        {/*
          `overflow-x-clip` alongside `overflow-y-auto` on purpose: one axis set to
          a non-visible value forces the other off `visible`, so `auto` here was
          quietly making the column scroll sideways as well. `clip` is the value
          that opts out of that, which keeps the vertical scroll and drops the
          horizontal bar.
        */}
        <main className="min-w-0 flex-1 px-4 pt-6 pb-24 md:min-h-0 md:overscroll-contain md:overflow-y-auto md:overflow-x-clip md:px-8 md:pb-10 md:pt-8">
          {children}
        </main>

        <MobileNav />
      </div>
    </div>
  );
}