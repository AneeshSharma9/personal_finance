"use client";

import { useEffect, useRef, useState } from "react";

/**
 * How long the exit animation runs. Must match `--animate-toast-down` in
 * globals.css.
 *
 * The unmount is driven by a timer rather than `onAnimationEnd` on purpose: with
 * `motion-reduce:animate-none` no animation ever fires, so an event-based
 * unmount would leave the toast stuck on screen for reduced-motion users.
 */
const EXIT_MS = 180;

/**
 * Bottom-anchored message that rises into place and sinks back out again.
 *
 * This lives in a fixed layer instead of inline in the page because the buttons
 * that raise these messages sit inside page headers. Rendered inline, the text
 * grew the header row and visibly nudged the button and heading beside it.
 *
 * `bottom-24` clears the fixed mobile tab bar (which is z-20 and adds the iPhone
 * home indicator); from `md` up there is no bar and it drops to `bottom-6`.
 * `z-50` keeps it above both that bar and the user menu panel.
 *
 * The caller keys on its own counter so a repeat of the same message remounts
 * this and restarts the hold.
 */
export function Toast({
  message,
  tone = "success",
  onDismiss,
  duration = 4000,
}: {
  message: string;
  tone?: "success" | "error";
  onDismiss: () => void;
  duration?: number;
}) {
  const [closing, setClosing] = useState(false);
  const dismissRef = useRef(onDismiss);

  useEffect(() => {
    dismissRef.current = onDismiss;
  });

  // Hold on screen, then begin the exit.
  useEffect(() => {
    if (closing) return;
    const timer = setTimeout(() => setClosing(true), duration);
    return () => clearTimeout(timer);
  }, [message, duration, closing]);

  // Unmount only after the exit has played out.
  useEffect(() => {
    if (!closing) return;
    const timer = setTimeout(() => dismissRef.current(), EXIT_MS);
    return () => clearTimeout(timer);
  }, [closing]);

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex justify-center px-4 md:bottom-6">
      <p
        role={tone === "error" ? "alert" : "status"}
        className={`pointer-events-auto max-w-sm rounded-md px-4 py-2.5 text-sm font-medium shadow-lg motion-reduce:animate-none ${
          closing ? "animate-toast-down" : "animate-toast-up"
        } ${
          tone === "error"
            ? "bg-red-600 text-white dark:bg-red-500"
            : "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900"
        }`}
      >
        {message}
      </p>
    </div>
  );
}