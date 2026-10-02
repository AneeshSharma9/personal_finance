"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Destructive-action confirmation for unlinking.
 *
 * Two things make this dialog non-optional rather than decorative:
 *
 *  1. Unlinking is irreversible and cascades: the institution, its accounts, and
 *     every transaction synced from them.
 *  2. Plaid's `/item/remove` does NOT return the Item to the Trial plan's
 *     10-Item allowance. The slot is spent. Saying that before the click is the
 *     whole point of this component.
 *
 * Fetches the real counts first so the user sees "this will delete 387
 * transactions" rather than a vague warning.
 */

export type UnlinkImpact = {
  institutionName: string | null;
  environment: string;
  status: string;
  accounts: number;
  transactions: number;
};

/**
 * Coerce the API payload to the shape we render.
 *
 * The counts are rendered directly, so a row object leaking out of the query
 * layer (e.g. `{ n: 387 }` instead of `387`) would throw "Objects are not valid
 * as a React child" and take the whole page down. Normalising here means a
 * contract change degrades to a wrong number rather than a blank screen.
 */
function toImpact(data: unknown): UnlinkImpact | null {
  if (typeof data !== "object" || data === null) return null;
  const raw = data as Record<string, unknown>;

  const asCount = (value: unknown): number => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
  };

  return {
    institutionName:
      typeof raw.institutionName === "string" ? raw.institutionName : null,
    environment: typeof raw.environment === "string" ? raw.environment : "",
    status: typeof raw.status === "string" ? raw.status : "unknown",
    accounts: asCount(raw.accounts),
    transactions: asCount(raw.transactions),
  };
}

export function UnlinkButton({
  itemId,
  institutionName,
}: {
  itemId: number;
  institutionName: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [impact, setImpact] = useState<UnlinkImpact | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState("");

  /**
   * Fetch the counts on open, so the warning is concrete ("this will delete 387
   * transactions"). Done in the click handler rather than an effect on `open`:
   * it is a one-shot user action, not state synchronised with anything.
   */
  async function openDialog() {
    setOpen(true);
    setError(null);
    setConfirmText("");
    setImpact(null);
    setLoading(true);
    try {
      const response = await fetch(`/api/items/${itemId}`);
      if (!response.ok) {
        setError("Could not check what would be deleted.");
        return;
      }
      const parsed = toImpact(await response.json());
      if (!parsed) {
        setError("Unexpected response from the server.");
        return;
      }
      setImpact(parsed);
    } catch {
      setError("Could not check what would be deleted.");
    } finally {
      setLoading(false);
    }
  }

  async function unlink() {
    setBusy(true);
    setError(null);

    try {
      const response = await fetch(`/api/items/${itemId}`, {
        method: "DELETE",
      });
      const data = (await response.json()) as { error?: string };

      if (!response.ok) {
        setError(data.error ?? "Could not unlink.");
        return;
      }

      setOpen(false);
      setConfirmText("");
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not unlink.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={openDialog}
        className="rounded-md border border-red-300 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
      >
        Unlink
      </button>
    );
  }

  const label = institutionName ?? "this institution";
  const canConfirm = !busy && confirmText.trim().toLowerCase() === label.toLowerCase();

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Unlink ${label}`}
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center"
    >
      <div className="w-full max-w-md rounded-lg bg-white p-4 shadow-xl dark:bg-neutral-800">
        <h2 className="text-lg font-semibold">Unlink {label}?</h2>

        <div className="mt-3 space-y-3 text-sm">
          {loading ? (
            <p className="text-neutral-500">Checking what would be deleted...</p>
          ) : null}

          {impact ? (
            <>
              <p>This permanently deletes:</p>
              <ul className="ml-4 list-disc space-y-0.5 text-neutral-700 dark:text-neutral-300">
              <li>
                <strong>{impact.institutionName ?? label}</strong> as a linked
                institution
              </li>
              <li>
                <strong>{impact.accounts}</strong> account
                {impact.accounts === 1 ? "" : "s"}
              </li>
              <li>
                <strong>{impact.transactions}</strong> transaction
                {impact.transactions === 1 ? "" : "s"}
                </li>
              </ul>
            </>
          ) : null}

          <p className="rounded-md bg-amber-50 px-3 py-2 text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            <strong>This does not give you the slot back.</strong> Removing an
            institution does not free one of the 10 Items on your Plaid Trial
            plan, and re-linking later creates a new one.
          </p>

          <p className="text-neutral-500">
            Your budgets and buckets are kept; they will just report $0 until the
            account is linked again.
          </p>

          {impact?.environment === "production" ? (
            <p className="rounded-md bg-red-50 px-3 py-2 text-red-800 dark:bg-red-950 dark:text-red-300">
              This is a <strong>production</strong> institution holding real bank
              data.
            </p>
          ) : null}
        </div>

        <label className="mt-4 block text-sm">
          <span className="mb-1 block text-xs text-neutral-500">
            Type <strong>{label}</strong> to confirm
          </span>
          <input
            value={confirmText}
            onChange={(event) => setConfirmText(event.target.value)}
            autoComplete="off"
            className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-800"
          />
        </label>

        {error ? (
          <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        ) : null}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setConfirmText("");
            }}
            disabled={busy}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-neutral-700"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={unlink}
            disabled={!canConfirm}
            className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
          >
            {busy ? "Unlinking..." : "Unlink permanently"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Remove a single account without unlinking the whole institution. */
export function RemoveAccountButton({
  accountId,
  accountName,
  transactionCount,
}: {
  accountId: number;
  accountName: string;
  transactionCount: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/accounts/${accountId}`, {
        method: "DELETE",
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        setError(data.error ?? "Could not remove the account.");
        return;
      }
      setOpen(false);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Remove ${accountName}`}
        className="shrink-0 text-neutral-400 hover:text-red-600"
      >
        &times;
      </button>
    );
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Remove ${accountName}`}
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center"
    >
      <div className="w-full max-w-md rounded-lg bg-white p-4 shadow-xl dark:bg-neutral-800">
        <h2 className="text-lg font-semibold">Remove {accountName}?</h2>
        <p className="mt-2 text-sm">
          This deletes the account and its{" "}
          <strong>{transactionCount}</strong> transaction
          {transactionCount === 1 ? "" : "s"}. The institution stays linked, and
          you can still unlink it separately.
        </p>

        {error ? (
          <p role="alert" className="mt-2 text-sm text-red-600">
            {error}
          </p>
        ) : null}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setOpen(false)}
            disabled={busy}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-neutral-700"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={remove}
            disabled={busy}
            className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
          >
            {busy ? "Removing..." : "Remove"}
          </button>
        </div>
      </div>
    </div>
  );
}