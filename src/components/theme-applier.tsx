"use client";

import { useEffect } from "react";

/**
 * Puts the theme back if it is ever missing.
 *
 * The inline script in layout.tsx is what applies the theme before first paint,
 * and on an ordinary load it is sufficient. On the home-screen PWA it is not,
 * because iOS does not always give you an ordinary load: closing the app and
 * reopening it can restore the saved document rather than re-fetching it, and the
 * restore can land with `<html>` missing the `dark` class the script had added.
 * Nothing else corrects it - `ThemeToggle` renders only while the user menu is
 * open, so there is no component on the page that owns this. The result is the
 * worst possible failure for a theme: the toggle still reads "dark" from
 * localStorage and shows dark pressed, while the page is plainly light.
 *
 * This is the safety net rather than the mechanism, and it is not a replacement
 * for the script. Removing it would reintroduce a flash of the wrong theme on
 * every load, which is the thing the script exists to prevent; a class applied
 * from an effect lands after React has already painted.
 *
 * Runs once on mount and whenever the page becomes visible again, the latter
 * because the restore is not a navigation and so fires no effect.
 *
 * Reads localStorage directly rather than `ThemeToggle`'s helpers so this module
 * has no dependency on the toggle being rendered - it lives in the root layout and
 * has to work on the login page too, where there is no toggle at all.
 */
const STORAGE_KEY = "theme";

export function ThemeApplier() {
  useEffect(() => {
    function apply() {
      let prefersDark = false;
      try {
        prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      } catch {
        // No matchMedia: fall back to light, which is what the page is already
        // showing and so cannot make it worse.
      }

      let stored: string | null = null;
      try {
        stored = localStorage.getItem(STORAGE_KEY);
      } catch {
        // Storage unavailable; the OS preference is all we have.
      }

      // Deliberately a recompute rather than a "re-add if I removed it" flag: this
      // must also repair a document restored without the class, and it must not
      // add a class the user has since chosen against.
      const dark = stored === "dark" ? true : stored === "light" ? false : prefersDark;

      const isDark = document.documentElement.classList.contains("dark");
      if (dark !== isDark) {
        document.documentElement.classList.toggle("dark", dark);
      }
    }

    apply();

    /*
     * `visibilitychange` rather than `pageshow`, because Safari only reliably
     * delivers `pageshow` to a bfcache restore and this has to work on every
     * browser the PWA might be launched from. Guarded on `visible` so a
     * background tab does not touch the class on the way past.
     */
    const onVisibility = () => {
      if (document.visibilityState === "visible") apply();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onVisibility);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onVisibility);
    };
  }, []);

  return null;
}