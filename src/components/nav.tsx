"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Navigation links with active-page state.
 *
 * Split out as a client component so `usePathname` is available while the
 * surrounding shell stays a Server Component.
 *
 * Icons matter here rather than being decoration: the mobile bar is 5 items
 * across a phone screen, and text-only labels wrapped and clipped at that width.
 * An icon plus a short label fits without wrapping.
 */
export const NAV_ITEMS = [
  { href: "/", label: "Home", full: "Dashboard", icon: HomeIcon },
  { href: "/accounts", label: "Accounts", full: "Accounts", icon: BankIcon },
  {
    href: "/transactions",
    label: "Txns",
    full: "Transactions",
    icon: ListIcon,
  },
  { href: "/budgets", label: "Budgets", full: "Budgets", icon: PieIcon },
  { href: "/net-worth", label: "Worth", full: "Net worth", icon: TrendIcon },
] as const;

/** `/accounts` should not light up when you're on `/budgets/[id]`. */
function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

/** Sidebar list, `md` and up. */
export function DesktopNav() {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-1">
      {NAV_ITEMS.map((item) => {
        const active = isActive(pathname, item.href);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm transition ${
              active
                ? "bg-neutral-100 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-white"
                : "text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
            }`}
          >
            <Icon active={active} />
            {item.full}
          </Link>
        );
      })}
    </nav>
  );
}

/** Bottom bar, below `md`. Fixed to the bottom for thumb reach on iPhone. */
export function MobileNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-20 border-t border-neutral-200 bg-white/95 backdrop-blur md:hidden dark:border-neutral-800 dark:bg-neutral-950/95"
      // env() keeps the bar clear of the iPhone home indicator.
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <ul className="flex">
        {NAV_ITEMS.map((item) => {
          const active = isActive(pathname, item.href);
          const Icon = item.icon;
          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`flex h-14 flex-col items-center justify-center gap-0.5 whitespace-nowrap px-1 text-[10px] leading-none transition ${
                  active
                    ? "font-medium text-neutral-900 dark:text-white"
                    : "text-neutral-500 dark:text-neutral-400"
                }`}
              >
                <Icon active={active} />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

type IconProps = { active?: boolean };

function stroke(active?: boolean) {
  return active
    ? "stroke-neutral-900 dark:stroke-white"
    : "stroke-current";
}

function HomeIcon({ active }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`h-5 w-5 shrink-0 ${stroke(active)}`}
      aria-hidden
    >
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V20h14V9.5" />
      <path d="M9.5 20v-6h5v6" />
    </svg>
  );
}

function BankIcon({ active }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`h-5 w-5 shrink-0 ${stroke(active)}`}
      aria-hidden
    >
      <path d="M3 9.5 12 4l9 5.5" />
      <path d="M4.5 9.5V19" />
      <path d="M9.5 9.5V19" />
      <path d="M14.5 9.5V19" />
      <path d="M19.5 9.5V19" />
      <path d="M3 21h18" />
    </svg>
  );
}

function ListIcon({ active }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`h-5 w-5 shrink-0 ${stroke(active)}`}
      aria-hidden
    >
      <path d="M4 6h16" />
      <path d="M4 12h16" />
      <path d="M4 18h10" />
    </svg>
  );
}

function PieIcon({ active }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`h-5 w-5 shrink-0 ${stroke(active)}`}
      aria-hidden
    >
      <path d="M12 3v9h9" />
      <path d="M20.5 15.5A9 9 0 1 1 8.5 3.5" />
    </svg>
  );
}

function TrendIcon({ active }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`h-5 w-5 shrink-0 ${stroke(active)}`}
      aria-hidden
    >
      <path d="M3 17l6-6 4 4 8-8" />
      <path d="M15 7h6v6" />
    </svg>
  );
}