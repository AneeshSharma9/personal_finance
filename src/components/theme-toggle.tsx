"use client";

import { useEffect, useSyncExternalStore } from "react";

/**
 * Light / dark / system toggle.
 *
 * Two things make this more than a `useState` boolean:
 *
 * 1. **The initial value has to match the DOM.** layout.tsx runs an inline
 *    script before paint that adds `.dark` to <html> from localStorage or the OS
 *    preference. React never sees that, so the state is initialised from the DOM
 *    in an effect. Deriving it from `matchMedia` alone would disagree with the
 *    rendered page whenever the user had an explicit stored preference.
 *
 * 2. **System mode has to stay live.** With "system" selected, a change to the
 *    OS appearance while the tab is open should re-render, so a `change`
 *    listener is attached while that mode is active.
 */
export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "theme";

/*
 * The theme lives in localStorage and is mirrored onto <html> by the pre-paint
 * script in layout.tsx. That makes localStorage an external store, so
 * `useSyncExternalStore` is the right way to read it:
 *
 *  - it reads the DOM-decided value, so the highlighted option always matches
 *    what is actually rendered;
 *  - it returns `getServerSnapshot` during hydration, so there is no hydration
 *    mismatch, then re-renders with the real value - which is exactly the
 *    behaviour wanted here;
 *  - the `storage` listener keeps other open tabs in step.
 */
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(onStoreChange: () => void) {
  listeners.add(onStoreChange);
  // Fires in OTHER tabs, so re-apply the class there too.
  const onStorage = () => {
    sync(readStored());
    onStoreChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onStoreChange);
    window.removeEventListener("storage", onStorage);
  };
}

function apply(theme: Theme): void {
  setTheme(theme);
}

export function ThemeToggle() {
  const theme = useSyncExternalStore(
    subscribe,
    () => readStored(),
    // Nothing sensible to read on the server; "system" is the neutral default
    // and is replaced on the client's first render.
    () => "system" as Theme,
  );

  // Keep the page in step with the OS while in system mode.
  useEffect(() => {
    if (theme !== "system") return;

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => sync("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme]);

  const options: { value: Theme; label: string; icon: React.ReactNode }[] = [
    { value: "light", label: "Light", icon: <SunIcon /> },
    { value: "dark", label: "Dark", icon: <MoonIcon /> },
    { value: "system", label: "Match system", icon: <SystemIcon /> },
  ];

  return (
    <div
      role="group"
      aria-label="Colour theme"
      className="flex gap-1 rounded-md border border-neutral-200 p-1 dark:border-neutral-700"
    >
      {options.map((option) => {
        const selected = theme === option.value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => apply(option.value)}
            aria-pressed={selected}
            // Icon-only, so the accessible name and tooltip have to carry the
            // meaning the label used to.
            aria-label={`${option.label} theme`}
            title={option.label}
            className={`flex flex-1 items-center justify-center rounded py-2.5 transition ${
              selected
                ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900"
                : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
            }`}
          >
            {option.icon}
          </button>
        );
      })}
    </div>
  );
}

function setTheme(theme: Theme): void {
  try {
    // "system" is stored explicitly so the choice survives a reload.
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Private mode or storage disabled: the theme still applies for this page
    // view, it just won't persist.
  }
  sync(theme);
  emit();
}

function readStored(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") {
      return stored;
    }
  } catch {
    // Ignore and fall through to the OS preference.
  }
  return "system";
}

/** Apply the theme by toggling the class the CSS variant keys off. */
function sync(theme: Theme): void {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const dark = theme === "dark" || (theme === "system" && prefersDark);
  document.documentElement.classList.toggle("dark", dark);
}

function SunIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      className="h-4 w-4"
      aria-hidden
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
      aria-hidden
    >
      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
    </svg>
  );
}

function SystemIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
      aria-hidden
    >
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}