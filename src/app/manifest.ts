import type { MetadataRoute } from "next";

/**
 * PWA manifest (PLANNED_ARCHITECTURE.md section 9).
 *
 * `display: "standalone"` is what makes the home-screen icon launch without
 * Safari chrome, so it behaves like a native app.
 *
 * Generated as a route rather than a static file so the icon URLs stay correct.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Personal Finance",
    short_name: "Finance",
    description: "Track accounts, spending, budgets and net worth.",
    start_url: "/",
    // Return to the dashboard rather than the last visited page on relaunch.
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        // Maskable gets cropped to a circle on Android; keep art inset.
        src: "/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}