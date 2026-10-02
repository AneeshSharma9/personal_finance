import { formatCurrency } from "@/lib/format";
import type { HoldingWithDetails } from "@/lib/queries";

/**
 * Holdings, grouped into one subsection per account.
 *
 * The same security can sit in more than one account (a 401(k) and a taxable
 * broker holding the same fund), so grouping is by account rather than by
 * ticker - otherwise one holding would silently absorb the other.
 *
 * This is the multi-account presentation, for the net-worth page. An account's own
 * page wants `HoldingsTable` instead: it already has the account as its heading
 * and a balance as its headline figure, so repeating either here produced the
 * same name three times and the same total twice on screen.
 *
 * Server component: no interactivity, just a read of what the query returned.
 */
export function HoldingsList({
  holdings,
}: {
  holdings: HoldingWithDetails[];
}) {
  const groups = new Map<number, { name: string; rows: HoldingWithDetails[] }>();

  for (const holding of holdings) {
    const existing = groups.get(holding.accountId);
    if (existing) {
      existing.rows.push(holding);
    } else {
      groups.set(holding.accountId, {
        name: holding.accountName,
        rows: [holding],
      });
    }
  }

  const sections = [...groups.values()]
    .map((group) => ({
      name: group.name,
      rows: byValueDescending(group.rows),
      total: totalValue(group.rows),
    }))
    .sort((a, b) => b.total - a.total);

  const grandTotal = sections.reduce((sum, section) => sum + section.total, 0);

  return (
    <section>
      <header className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium text-neutral-500">Holdings</h2>
        <p className="text-xs tabular-nums text-neutral-500">
          {formatCurrency(grandTotal)}
        </p>
      </header>

      <div className="space-y-4">
        {sections.map((section) => (
          <div key={section.name}>
            <div className="mb-1 flex items-baseline justify-between gap-3">
              <h3 className="truncate text-sm font-medium">{section.name}</h3>
              <p className="shrink-0 text-xs tabular-nums text-neutral-500">
                {formatCurrency(section.total)}
              </p>
            </div>

            <HoldingsTable rows={section.rows} />
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * The positions themselves, largest first, and nothing else.
 *
 * No heading, no account name, no total - all three belong to whatever is
 * presenting the table, and on a single account's page all three are already on
 * screen. What is left is the part that is unique to each holding.
 */
export function HoldingsTable({ rows }: { rows: HoldingWithDetails[] }) {
  if (rows.length === 0) return null;

  return (
    <ul className="divide-y divide-neutral-100 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
      {byValueDescending(rows).map((holding) => (
        <li
          key={holding.id}
          className="flex items-center justify-between gap-3 px-4 py-3 text-sm"
        >
          <div className="min-w-0">
            <p className="truncate font-medium">
              {holding.tickerSymbol ?? holding.securityName}
            </p>
            <p className="text-xs text-neutral-500">
              {formatUnits(holding.quantity)} units
              {holding.securityType ? ` · ${holding.securityType}` : ""}
            </p>
          </div>
          <p className="shrink-0 tabular-nums">
            {holding.institutionValue !== null
              ? formatCurrency(holding.institutionValue)
              : "-"}
          </p>
        </li>
      ))}
    </ul>
  );
}

/** Sum of what the holdings are worth. A holding with no value counts as zero. */
export function totalValue(rows: HoldingWithDetails[]): number {
  return rows.reduce((sum, row) => sum + (row.institutionValue ?? 0), 0);
}

function byValueDescending(rows: HoldingWithDetails[]): HoldingWithDetails[] {
  return [...rows].sort((a, b) => (b.institutionValue ?? 0) - (a.institutionValue ?? 0));
}

/**
 * Share counts, which arrive as Postgres numerics.
 *
 * Trimmed to 4 decimals so a fractional 4.4818 survives intact while a whole 2
 * does not render as "2.0000".
 */
function formatUnits(raw: number): string {
  if (!Number.isFinite(raw)) return "0";
  return raw.toLocaleString("en-US", { maximumFractionDigits: 4 });
}