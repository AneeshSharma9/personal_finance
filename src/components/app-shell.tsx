import Link from "next/link";

const NAV_ITEMS = [
  { href: "/", label: "Dashboard" },
  { href: "/accounts", label: "Accounts" },
  { href: "/transactions", label: "Transactions" },
  { href: "/budgets", label: "Budgets" },
  { href: "/net-worth", label: "Net worth" },
] as const;

/**
 * App shell.
 *
 * Mobile-first: a bottom tab bar for thumb reach on iPhone (section 9), a
 * sidebar from the `md` breakpoint up.
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
    <div className="min-h-dvh md:flex">
      {/* Desktop sidebar */}
      <aside className="hidden border-r border-neutral-200 p-4 md:block md:w-56 md:shrink-0 dark:border-neutral-800">
        <Link href="/" className="mb-6 block text-lg font-semibold">
          Finance
        </Link>
        <nav className="flex flex-col gap-1">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-md px-3 py-2 text-sm text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="mt-8 border-t border-neutral-200 pt-4 dark:border-neutral-800">
          {email ? (
            <p className="mb-2 truncate text-xs text-neutral-500">{email}</p>
          ) : null}
          {signOut}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile header */}
        <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-3 md:hidden dark:border-neutral-800">
          <Link href="/" className="text-base font-semibold">
            Finance
          </Link>
          {signOut}
        </header>

        <main className="min-w-0 flex-1 px-4 pt-4 pb-24 md:px-8 md:pb-8">
          {children}
        </main>

        {/* Mobile bottom nav */}
        <nav className="fixed inset-x-0 bottom-0 z-10 flex border-t border-neutral-200 bg-white/95 backdrop-blur md:hidden dark:border-neutral-800 dark:bg-neutral-950/95">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[11px] text-neutral-600 dark:text-neutral-400"
              // Comfortable tap target on iPhone.
              style={{ minHeight: 48 }}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </div>
    </div>
  );
}