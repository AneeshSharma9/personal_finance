/**
 * Money input parsing.
 *
 * Lives here rather than inside a route because two routes now parse the same
 * shapes (budgets and loans) and a private copy per route drifts. The database
 * side is covered by `toNumber` in src/db/schema.ts.
 */

/**
 * Parse a money input, tolerating "$", commas and whitespace. Null when
 * unparseable, so a typo is rejected rather than silently stored as 0.
 */
export function parseMoney(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string") return null;

  const cleaned = value.replace(/[$,\s]/g, "");
  if (cleaned.length === 0) return 0;

  const parsed = Number(cleaned);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Parse a percentage input, tolerating a trailing "%". Null when unparseable.
 *
 * Stored as a percent, matching `liabilities.apr`: 5.9 means 5.9%.
 */
export function parsePercent(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string") return null;

  const cleaned = value.replace(/[%\s]/g, "");
  if (cleaned.length === 0) return null;

  const parsed = Number(cleaned);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** Parse a `YYYY-MM-DD` date, returning it normalised. Null when invalid. */
export function parseDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;

  // Round-trip through Date to reject things like 2026-02-31.
  const parsed = new Date(`${trimmed}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed.toISOString().slice(0, 10) !== trimmed) return null;

  return trimmed;
}