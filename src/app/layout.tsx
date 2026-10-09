import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { ThemeApplier } from "@/components/theme-applier";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Finance",
  description: "Personal finance tracker",
  appleWebApp: {
    // Gives the home-screen PWA a proper name instead of the page title.
    title: "Finance",
    capable: true,
    statusBarStyle: "default",
    startupImage: "/apple-touch-icon.png",
  },
  /*
    * `favicon.ico` is deliberately absent from this list.
    *
    * An `app/favicon.ico` is injected by Next.js ahead of anything declared here,
    * so the Vercel placeholder that ships with a new project was being served as
    * the first `rel="icon"` and winning. It has been replaced with the real mark,
    * but leaving it out here documents that `favicon.ico` is the one that decides
    * the tab icon and adding it back would be a second, redundant declaration.
    */
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
};

/**
 * Separate `viewport` export in Next.js 16: `themeColor` and `colorScheme` are
 * deprecated inside `metadata`.
 *
 * `media` variants follow the OS. The two `class` entries are swapped at
 * runtime by the theme script below, so the browser chrome matches an explicit
 * in-app choice rather than always tracking the OS.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Large tap targets on iPhone (see docs/architecture.md section 9).
  maximumScale: 5,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#171717" },
  ],
};

/**
 * Applies the stored theme before the first paint.
 *
 * Runs inline and synchronously: doing it in an effect or after hydration would
 * paint the wrong theme first and then flip, which is a visible flash on every
 * load. Nothing else runs before paint on a real page load either - `ThemeToggle`
 * lives inside the user menu, which is closed by default - so this is the only
 * thing that sets the class on load, and it cannot delegate to `sync`.
 *
 * The three-way decision mirrors `sync()` in theme-toggle.tsx and must stay
 * identical to it. It used to be `s ? s === "dark" : prefersDark`, which only
 * consulted the OS when the key was *absent* - so a stored `"system"` took the
 * `s === "dark"` branch and resolved to `false`. Since `setTheme` stores
 * `"system"` explicitly, picking "Match system" looked correct for the rest of
 * the session and then came back light on the next load, with the toggle still
 * showing "system" selected: the page is painted by this string and read by
 * `readStored()`, and the two disagreed. `prefers-color-scheme` is consulted
 * first so that a dark OS never even runs the comparisons that cannot reach it.
 */
const THEME_SCRIPT = `(function(){try{var p=window.matchMedia("(prefers-color-scheme: dark)").matches;var s=localStorage.getItem("theme");var d=s==="dark"?true:s==="light"?false:p;document.documentElement.classList.toggle("dark",d);}catch(e){}})();`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // suppressHydrationWarning: the script above mutates <html> before React
    // hydrates, so the server and client markup legitimately differ.
    <html lang="en" suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="antialiased">
      {/*
        Repair net, not mechanism. The script above is what themes the first
        paint; this fixes the home-screen PWA case where iOS restores the document
        without it and no component on the page would otherwise notice. See
        ThemeApplier for why it cannot live in ThemeToggle.
      */}
      <ThemeApplier />
      {children}
    </body>
    </html>
  );
}