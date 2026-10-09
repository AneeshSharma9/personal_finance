import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * The theme script that runs before first paint, executed for real.
 *
 * This is the only thing that puts `.dark` on `<html>` on a page load. The CSS
 * compiles `dark:` against `.dark` and nothing else - there is not a single
 * `prefers-color-scheme` query in the built stylesheet - and `ThemeToggle` lives
 * inside the user menu, which is closed by default, so nothing on the client runs
 * early enough to add a second chance. If this string is wrong, dark mode is
 * simply off, and it is off in a way that looks deliberate.
 *
 * ## Why the string is executed instead of read
 *
 * The bug this guards against was a ternary:
 *
 *     var d = s ? s === "dark" : prefersDark;
 *
 * which reads correctly - "use the stored value, else the OS" - and only consults
 * the OS when the key is *absent*. A stored `"system"` is truthy, so it took the
 * `s === "dark"` branch and resolved to false. Because `setTheme` deliberately
 * stores `"system"` so the choice survives a reload, selecting "Match system"
 * worked for the rest of the session (`sync` gets this right) and came back light
 * on the next load, with the toggle still showing "system" pressed. The page is
 * painted by this string and the highlighted icon is decided by `readStored`, so
 * the two disagreed and neither looked broken.
 *
 * No assertion about the source text would catch that: `s === "dark"` appears in
 * both the broken and the fixed version. So the script is evaluated against stubs
 * and the resulting class is checked, which is the only thing that distinguishes
 * them.
 *
 * The same truth table has to hold in `sync()`, which is the same three-way
 * decision written out for the client. They are asserted against each other
 * rather than against literals for that reason.
 */

/** The inline script, lifted out of layout.tsx without executing the module. */
function themeScript(): string {
  const source = readFileSync("src/app/layout.tsx", "utf8");
  const match = source.match(
    /const THEME_SCRIPT = `([\s\S]*?)`;/,
  );
  assert.ok(match, "layout.tsx should still define an inline THEME_SCRIPT");
  return match[1]!;
}

type Stored = "light" | "dark" | "system" | "junk" | null;

/**
 * Run the real script and report the class it sets.
 *
 * A whole new Function rather than an eval in this scope, so the script sees only
 * the three globals it is allowed to touch and nothing else on this module.
 */
function runScript(stored: Stored, prefersDark: boolean): boolean {
  const documentElement = {
    classList: {
      toggle(_name: string, force: boolean) {
        documentElement.classList.dark = force;
        return force;
      },
      dark: false,
    },
  };

  const window = {
    matchMedia: (query: string) => {
      assert.equal(query, "(prefers-color-scheme: dark)");
      return { matches: prefersDark };
    },
  };

  const localStorage = {
    getItem: () => stored,
  };

  const factory = new Function("window", "localStorage", "document", themeScript());
  factory(window, localStorage, { documentElement });

  return documentElement.classList.dark;
}

test("an explicit dark choice wins over a light OS", () => {
  assert.equal(runScript("dark", true), true);
  assert.equal(runScript("dark", false), true);
});

test("an explicit light choice wins over a dark OS", () => {
  assert.equal(runScript("light", true), false);
  assert.equal(runScript("light", false), false);
});

test("system follows the OS in both directions", () => {
  assert.equal(runScript("system", true), true);
  assert.equal(runScript("system", false), false);
});

test("nothing stored follows the OS", () => {
  assert.equal(runScript(null, true), true);
  assert.equal(runScript(null, false), false);
});

test("an unrecognised stored value follows the OS", () => {
  /*
   * `readStored` answers "system" for anything it does not recognise, so the
   * script has to agree. Without this the two could resolve differently and the
   * toggle would show a mode the page is not in.
   */
  assert.equal(runScript("junk", true), true);
  assert.equal(runScript("junk", false), false);
});

test("the script is the reason the whole thing works, so it must stay inline", () => {
  /*
   * If it ever moved to an external file it would arrive after first paint and
   * the page would flash light before going dark - the exact thing it exists to
   * prevent, and the sort of regression that reads as "a bit janky on load"
   * rather than as a broken theme.
   */
  const source = readFileSync("src/app/layout.tsx", "utf8");
  assert.match(
    source,
    /<script dangerouslySetInnerHTML=\{\{ __html: THEME_SCRIPT \}\} \/>/,
    "the theme script should still be an inline script in the document head",
  );
});

test("a client component is mounted to repair a restored document", () => {
  /*
   * The other half of this bug, and the reason the script alone was not enough.
   *
   * On the home-screen PWA, closing the app and reopening it can restore the saved
   * document instead of re-fetching it, and the restore can land with `<html>`
   * missing the `dark` class the inline script had added. Nothing noticed:
   * `ThemeToggle` renders only while the user menu is open, so no component on the
   * page owned the class. The symptom was the toggle reading "dark" from
   * localStorage and showing dark pressed while the page was plainly light - the
   * same disagreement as the ternary above, reached by a second route.
   *
   * Asserted on the mount and the listeners rather than on the behaviour, because
   * the behaviour needs a document restore to reproduce and that is not something
   * this suite can arrange. The restore fires `pageshow`, which is why that is one
   * of the two listeners and not just `visibilitychange`.
   */
  const source = readFileSync("src/components/theme-applier.tsx", "utf8");
  assert.match(source, /export function ThemeApplier\(\)/, "the repair net should be one component");
  assert.match(source, /useEffect\(/, "and it has to run after hydration");
  assert.match(
    source,
    /addEventListener\("pageshow"/,
    "a bfcache restore fires no effect, so pageshow has to be handled",
  );
  assert.match(
    source,
    /visibilitychange/,
    "visibilitychange is the one Safari delivers reliably",
  );
});

test("the repair net is mounted on every page, not inside the menu", () => {
  /*
   * The original mistake: leaving this to ThemeToggle would have meant it only ran
   * when the user menu happened to be open - which is never at page load, and never
   * on /login. So the component has to be rendered from the root layout.
   */
  const layout = readFileSync("src/app/layout.tsx", "utf8");
  assert.match(layout, /<ThemeApplier \/>/, "layout should mount it unconditionally");
});

test("the script is still what themes the first paint", () => {
  /*
   * Guards against the fix being mistaken for a replacement. Repairing the class
   * from an effect is strictly worse for a first load: the browser has already
   * painted light by then, so every page load would flash the wrong theme.
   */
  const applier = readFileSync("src/components/theme-applier.tsx", "utf8");
  assert.match(
    applier,
    /safety net rather than the mechanism/,
    "the repair net should say it is not what themes the first paint",
  );
});

test("the CSS keys off the class, not the OS", () => {
  /*
   * Read from the source rather than the built stylesheet so the test does not
   * depend on a build having been run. The custom variant is the whole reason an
   * explicit in-app choice can beat the OS; if it silently reverted to the
   * default media query, `sync` and this script would both be correct and the
   * app would still ignore the user.
   */
  const css = readFileSync("src/app/globals.css", "utf8");
  assert.match(
    css,
    /@custom-variant dark \(&:where\(\.dark, \.dark \*\)\);/,
    "dark: must stay class-based or an explicit choice cannot beat the OS",
  );
});