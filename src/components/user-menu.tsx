"use client";

import { useEffect, useRef, useState } from "react";

import { ThemeToggle } from "@/components/theme-toggle";

/**
 * Signed-in user with a reveal-on-tap panel containing the theme toggle and
 * sign-out.
 *
 * `placement` matters: the sidebar control sits at the bottom of a tall column so
 * its panel opens upward, while the mobile header control is at the top of the
 * screen and must open downward. Without this the mobile panel renders above the
 * header, off-screen.
 *
 * Closes on outside click and Escape so it can't get stuck open.
 */
export function UserMenu({
  email,
  signOut,
  placement = "top",
}: {
  email: string | null;
  signOut: React.ReactNode;
  placement?: "top" | "bottom";
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent | TouchEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const label = email ?? "Signed in";

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
      >
        <span
          aria-hidden
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-neutral-200 text-[11px] font-semibold text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200"
        >
          {initials(label)}
        </span>
        <span className="min-w-0 flex-1 truncate text-neutral-600 dark:text-neutral-400">
          {label}
        </span>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          className={`h-4 w-4 shrink-0 text-neutral-400 transition ${
            open ? "rotate-180" : ""
          }`}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open ? (
        <div
          className={`absolute inset-x-0 z-30 rounded-md border border-neutral-200 bg-white p-3 shadow-lg dark:border-neutral-700 dark:bg-neutral-800 ${
            placement === "top" ? "bottom-full mb-1" : "top-full mt-1"
          }`}
        >
          <div>
            <p className="mb-1.5 text-xs font-medium text-neutral-500">
              Theme
            </p>
            <ThemeToggle />
          </div>
          <div className="mt-3 border-t border-neutral-200 pt-3 dark:border-neutral-700">
            {signOut}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function initials(email: string): string {
  const local = email.split("@")[0] ?? email;
  const parts = local.split(/[._-]+/).filter(Boolean);
  const letters = (parts.length > 1 ? [parts[0], parts[1]] : [local])
    .map((part) => part.charAt(0))
    .join("");
  return (letters || "?").toUpperCase().slice(0, 2);
}