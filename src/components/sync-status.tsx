import Link from "next/link";

import { formatRelativeTime } from "@/lib/format";
import type { tables } from "@/db";

/**
 * How fresh the data is, in one line.
 *
 * The dashboard used to list every linked institution, which duplicated /accounts
 * and pushed the month's numbers off the screen. What is worth surfacing here is
 * the one thing that cannot be read off any other page: whether what you are
 * looking at is current.
 *
 * So: the most recent sync across all Items, plus a warning when any Item needs
 * attention — a stale balance that looks authoritative is worse than an obviously
 * broken one.
 */
export function SyncStatus({
  items,
}: {
  items: (Pick<tables.Item, "status" | "lastSyncedAt"> & {
    institutionName: string | null;
  })[];
}) {
  if (items.length === 0) return null;

  // The newest sync, not the average: one institution syncing this morning and
  // another last Tuesday is "synced this morning" as far as staleness goes, and
  // the attention list below is where the per-item detail belongs.
  const lastSyncedAt = items.reduce<Date | null>(
    (latest, item) =>
      item.lastSyncedAt && (!latest || item.lastSyncedAt > latest)
        ? item.lastSyncedAt
        : latest,
    null,
  );

  const needsAttention = items.filter((item) => item.status !== "healthy");

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500">
      <span>
        Last synced{" "}
        <span className="text-neutral-700 dark:text-neutral-300">
          {formatRelativeTime(lastSyncedAt?.toISOString() ?? null)}
        </span>
      </span>
      {needsAttention.length > 0 ? (
        <Link
          href="/accounts"
          className="rounded-md px-2 py-1 text-amber-700 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-950"
        >
          {needsAttention.length === 1
            ? "1 institution needs attention"
            : `${needsAttention.length} institutions need attention`}
        </Link>
      ) : null}
    </div>
  );
}