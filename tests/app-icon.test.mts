import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { inflateSync } from "node:zlib";

/**
 * The site's icon, which is decided by file *precedence* rather than by anything
 * that looks like a declaration.
 *
 * This is here because the wrong icon shipped. `public/icon.svg` was correct the
 * whole time and still did not appear: `app/favicon.ico` exists, and Next.js
 * injects a `rel="icon"` for it *before* the ones from `metadata.icons`, so the
 * Vercel placeholder that ships with a new project was first in the document and
 * won. Nothing in the manifest or the SVG was wrong, which is exactly why it is so
 * easy to look at them for a long time and find nothing.
 *
 * The assertion is on what the build actually emits, not on what the config says,
 * because the config was correct while the output was not.
 */

/** PNG IHDR colour type. 2 is RGB with no alpha, 6 is RGBA. */
function pngColorType(path: string): { width: number; height: number; colorType: number } {
  const data = readFileSync(path);
  assert.ok(
    data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    `${path} should be a PNG`,
  );
  return {
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
    colorType: data[25]!,
  };
}

test("app/favicon.ico exists, so it is the icon that decides the tab", () => {
  /*
   * Asserted as a fact about the repo rather than as a requirement, because the
   * fix is to *replace its contents* - not to delete it, and not to add it to
   * `metadata.icons`, where it would be a second declaration competing with the
   * injected one. If this ever starts failing the file was deleted and the
   * precedence rule no longer applies.
   */
  assert.ok(
    existsSync("src/app/favicon.ico"),
    "src/app/favicon.ico is what Next.js promotes ahead of metadata.icons",
  );
});

/** The PNG payload of the largest entry in an .ico. */
function largestIcoPng(ico: Buffer): { size: number; png: Buffer } {
  const count = ico.readUInt16LE(4);
  assert.ok(count >= 1, "an .ico with no entries paints nothing");

  let best = { size: 0, png: Buffer.alloc(0) };
  for (let i = 0; i < count; i += 1) {
    const entry = 6 + i * 16;
    const width = ico[entry] === 0 ? 256 : ico[entry]!;
    const height = ico[entry + 1] === 0 ? 256 : ico[entry + 1]!;
    assert.equal(width, height, "a non-square favicon entry would be padded oddly");
    const bytes = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    if (width <= best.size) continue;
    if (
      ico
        .subarray(offset, offset + 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ) {
      best = { size: width, png: Buffer.from(ico.subarray(offset, offset + bytes)) };
    }
  }
  assert.ok(best.png.length > 0, "the favicon should contain at least one PNG entry");
  return best;
}

/** Un-filter a PNG's scanlines and return them as RGBA rows. */
function pngPixels(png: Buffer): { width: number; height: number; rows: number[][] } {
  let pos = 8;
  const idat: Buffer[] = [];
  let width = 0;
  let height = 0;
  let colorType = 0;
  while (pos < png.length) {
    const length = png.readUInt32BE(pos);
    const type = png.subarray(pos + 4, pos + 8).toString("latin1");
    const data = png.subarray(pos + 8, pos + 8 + length);
    pos += 12 + length;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9]!;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }
  /*
   * 2 (RGB) and 6 (RGBA) only. RGB is widened to RGBA here so the callers can ask
   * about alpha unconditionally - and for an opaque icon that question is answered
   * "255" by construction rather than by the encoder having added a channel.
   */
  assert.ok(
    colorType === 2 || colorType === 6,
    `expected a non-paletted RGB or RGBA PNG, got colour type ${colorType}`,
  );

  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const out: number[][] = [];
  let previous = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!;
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride));
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? line[x - channels]! : 0;
      const b = previous[x]!;
      const c = x >= channels ? previous[x - channels]! : 0;
      if (filter === 1) line[x] = (line[x]! + a) & 255;
      else if (filter === 2) line[x] = (line[x]! + b) & 255;
      else if (filter === 3) line[x] = (line[x]! + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pick = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        line[x] = (line[x]! + pick) & 255;
      }
    }
    const row: number[] = [];
    for (let x = 0; x < width; x += 1) {
      /*
       * Alpha read from the pixel, not assumed. An RGB image has no channel and
       * is opaque by definition, but an RGBA one has to be *asked* - and assuming
       * 255 is precisely the mistake that let the Vercel placeholder through this
       * test the first time round, since its corners are transparent black and so
       * look identical to opaque black once alpha is invented.
       */
      const alpha = channels === 4 ? line[x * channels + 3]! : 255;
      row.push(line[x * channels]!, line[x * channels + 1]!, line[x * channels + 2]!, alpha);
    }
    out.push(row);
    previous = line;
  }
  return { width, height, rows: out };
}

function pixelAt(png: Buffer, x: number, y: number): number[] {
  const { rows } = pngPixels(png);
  return [rows[y]![x * 4]!, rows[y]![x * 4 + 1]!, rows[y]![x * 4 + 2]!, rows[y]![x * 4 + 3]!];
}

test("the favicon is the app's mark, not the Vercel placeholder", () => {
  /*
   * Checked by *pixel*, and specifically at the corners, because every structural
   * property holds for the placeholder too: it is a valid .ico with 16/32/48/256
   * entries, so a test asserting the shape passed on the exact file that caused the
   * bug. The two are told apart by their corners - the placeholder is a circle on
   * transparency, so its corners are fully transparent, while this icon is a dark
   * rounded square with no alpha at all.
   *
   * A corner that is opaque `#0a0a0a` cannot come from the placeholder.
   */
  const ico = readFileSync("src/app/favicon.ico");
  const { size, png } = largestIcoPng(ico);
  assert.equal(size, 256, "a 256 entry is what a reader asking for the largest one gets");

  for (const [x, y] of [
    [1, 1],
    [size - 2, 1],
    [1, size - 2],
    [size - 2, size - 2],
  ] as const) {
    const [r, g, b, a] = pixelAt(png, x, y);
    assert.equal(a, 255, `corner (${x},${y}) should be opaque, got alpha ${a}`);
    assert.ok(
      r < 40 && g < 40 && b < 40,
      `corner (${x},${y}) should be the dark #0a0a0a background, got rgb(${r},${g},${b})`,
    );
  }
});

test("the favicon ships every size a browser might ask for", () => {
  /*
   * A tab requests 16x16 or 32x32 and a reader may ask for 256. Shipping only one
   * size means the others get resampled from whatever was closest, which is how a
   * correct 512 ends up blurry in the one place the user actually sees it.
   */
  const ico = readFileSync("src/app/favicon.ico");
  const sizes = new Set<number>();
  const count = ico.readUInt16LE(4);
  for (let i = 0; i < count; i += 1) {
    const entry = 6 + i * 16;
    sizes.add(ico[entry] === 0 ? 256 : ico[entry]!);
  }
  for (const size of [16, 32, 48, 256]) {
    assert.ok(sizes.has(size), `the favicon should include a ${size}x${size} entry`);
  }
});

test("the apple touch icon is opaque, or iOS renders it on black", () => {
  /*
   * iOS does not composite an alpha channel for a home-screen icon: any
   * transparency comes out black, so a rounded-corner PNG gets a black square
   * behind it. The SVG's rounded rect is fine for the web and wrong here, which
   * is why this icon is generated separately rather than scaled from it.
   *
   * Colour type 2 is RGB with no alpha. 4 is greyscale+alpha, 6 is RGBA.
   */
  const { width, height, colorType } = pngColorType("public/apple-touch-icon.png");
  assert.equal(width, 180, "iOS looks for a 180x180 apple-touch-icon");
  assert.equal(height, 180);
  assert.ok(
    colorType === 2,
    `apple-touch-icon.png must be opaque, got colour type ${colorType}`,
  );
});

test("the maskable icon is opaque and full-bleed", () => {
  /*
   * Android applies its own mask - circle, squircle, rounded square - chosen by
   * the launcher's own theme. Anything not full-bleed gets cropped, and the
   * safe-zone inset in `icon-maskable.svg` is what keeps the mark inside that
   * crop. So this must stay opaque: a transparent maskable icon is masked against
   * whatever is behind it, which is the home screen wallpaper.
   */
  const { width, height, colorType } = pngColorType("public/icon-maskable-512.png");
  assert.equal(width, 512);
  assert.equal(height, 512);
  assert.equal(colorType, 2, "the maskable icon must be opaque");
});

test("the icon SVG carries the same dark background the theme uses", () => {
  /*
   * Not cosmetic. The favicon is generated from this file, and a mismatch between
   * it and the page background shows up as a visible tile edge in dark mode.
   * `#0a0a0a` is also what `manifest.background_color` is set to, so the launch
   * screen does not flash white on the way to a dark page.
   */
  const svg = readFileSync("public/icon.svg", "utf8");
  assert.match(svg, /fill="#0a0a0a"/, "the icon should have a dark background");
  assert.match(svg, /stroke="#ffffff"/, "with a light mark on top");
});

test("the manifest background matches the icon, not the page's light default", () => {
  const manifest = readFileSync("src/app/manifest.ts", "utf8");
  assert.match(
    manifest,
    /background_color: "#0a0a0a"/,
    "a white launch screen flashes before a dark page appears",
  );
  assert.match(manifest, /theme_color: "#0a0a0a"/);
});