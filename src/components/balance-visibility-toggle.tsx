"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";

/**
 * Press to hide every balance, press again to show them.
 *
 * Wraps the figure rather than replacing it, so the page keeps its own layout -
 * the control is a `<button>` styled to look like the number it sits on, and
 * `children` is whatever that page renders there. The net worth headline uses it
 * on both pages that have one.
 *
 * The one thing this must not do is hide the numbers *client-side*. The
 * preference is a cookie the server reads (see `lib/privacy.ts`), so the masked
 * figures are what the server sent: toggling is a POST and a re-render rather
 * than a state flip. That costs a round trip on each press, and buys the absence
 * of a flash - and of the real figures sitting in the HTML in between.
 *
 * `aria-pressed` rather than a label that changes: the button's action does not
 * change, its state does. A screen reader announcing "Show balances" over a
 * hidden set of figures would be describing the future rather than the present.
 */
export function BalanceVisibilityToggle({
  hidden,
  children,
  className,
}: {
  /** Current preference, from the page's own cookie read. */
  hidden: boolean;
  children: ReactNode;
  className?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    setError(null);
    try {
      const response = await fetch("/api/visibility", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hidden: !hidden }),
      });
      if (!response.ok) {
        setError("Could not change that.");
        return;
      }
      // The server has to re-render for the masked text to exist, so a refresh is
      // the actual update here rather than a courtesy.
      startTransition(() => router.refresh());
    } catch {
      setError("Could not reach the server.");
    }
  }

  return (
    <span className="inline-flex flex-col items-start">
      <button
        type="button"
        onClick={() => void toggle()}
        disabled={pending}
        aria-pressed={hidden}
        title={
          hidden
            ? "Balances are hidden. Press to show them."
            : "Press to hide balances"
        }
        className={`rounded px-1 py-0.5 text-left transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-800 ${className ?? ""}`}
      >
        {children}
      </button>
      {/*
        Only reachable if the POST failed, so it sits under the figure rather than
        in a banner at the top of the page: the control that failed is the one that
        should say so.
      */}
      {error ? (
        <span role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </span>
      ) : null}
    </span>
  );
}