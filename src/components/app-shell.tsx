import Link from "next/link";

import { DesktopNav, MobileNav } from "@/components/nav";
import { UserMenu } from "@/components/user-menu";

/**
 * App shell.
 *
 * On `md` and up the viewport is split into a fixed sidebar and a scrolling main
 * column: only the page content scrolls, so the navigation and the user control
 * stay put. That needs the container to be exactly viewport height
 * (`md:h-dvh`, not `min-h-dvh`) - otherwise the container grows with the content
 * and `mt-auto` pins the user control to the bottom of the *page* instead of the
 * screen. `min-h-0` on the column and main is what lets `overflow-y-auto` scroll
 * rather than expand.
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
    <div className="md:flex md:h-dvh md:overflow-hidden">
      <aside className="hidden border-r border-neutral-200 md:flex md:w-60 md:shrink-0 md:flex-col md:overflow-y-auto p-4 dark:border-neutral-800">
        <Link href="/" className="mb-6 block text-lg font-semibold">
          Finance
        </Link>

        <DesktopNav />

        {/*
          mt-auto pins this to the bottom of the viewport, because the aside is
          stretched to the full height of the h-dvh container.
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
        <main className="min-w-0 flex-1 px-4 pt-6 pb-24 md:min-h-0 md:overflow-y-auto md:px-8 md:pb-10 md:pt-8">
          {children}
        </main>

        <MobileNav />
      </div>
    </div>
  );
}