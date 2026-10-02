"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";

import { Toast } from "@/components/toast";

/**
 * Combine several buckets into one.
 *
 * For buckets that are really one line of the budget - "Food And Drink Coffee"
 * and "Dining & Drinks" are the same thing to the person paying it - where the
 * alternative is moving transactions across by hand forever.
 *
 * The whole merge happens server-side in one transaction, so a failure part-way
 * leaves nothing half-merged.
 */
export function MergeBuckets({
  buckets,
}: {
  buckets: { id: number; name: string; kind: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ id: number; text: string } | null>(null);

  const [picked, setPicked] = useState<number[]>([]);
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [name, setName] = useState("");
  const [targetId, setTargetId] = useState("");
  const [limit, setLimit] = useState("");
  const nextNoticeId = useNoticeId();

  // Earnings is excluded: income is counted, not budgeted, so merging two
  // earnings buckets would mean double-counting pay.
  const mergeable = buckets.filter((b) => b.kind !== "earning");
  const sources = picked.map((id) => buckets.find((b) => b.id === id)).filter(Boolean);

  function toggle(id: number) {
    setPicked((current) =>
      current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (picked.length === 0) return;

    setError(null);
    const body =
      mode === "new"
        ? {
            sourceIds: picked,
            name,
            kind: sources[0]?.kind,
            monthlyLimit: limit === "" ? 0 : limit,
          }
        : { sourceIds: picked, targetId };

    try {
      const response = await fetch("/api/buckets/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        setError(data.error ?? "Could not merge those buckets.");
        return;
      }

      const data = (await response.json()) as {
        merged?: string[];
        transactionsMoved?: number;
        rulesRepointed?: number;
        rulesCreated?: number;
        target?: { name: string };
      };

      const bits = [`Merged ${data.merged?.length ?? 0} buckets into "${data.target?.name}"`];
      bits.push(`${data.transactionsMoved ?? 0} transactions moved`);
      if (data.rulesCreated) bits.push(`${data.rulesCreated} routing rules added`);
      if (data.rulesRepointed) bits.push(`${data.rulesRepointed} rules repointed`);

      setNotice({ id: nextNoticeId(), text: bits.join(". ") + "." });
      setPicked([]);
      setName("");
      setOpen(false);
      startTransition(() => router.refresh());
    } catch {
      setError("Could not reach the server.");
    }
  }

  // Same-kind only, matching the server's rule.
  const singleKind = sources.length > 0 && sources.every((s) => s?.kind === sources[0]?.kind);

  return (
    <section>
      <header className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium text-neutral-500">Combine buckets</h2>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-xs font-medium text-neutral-600 underline dark:text-neutral-400"
        >
          {open ? "Cancel" : "Merge buckets"}
        </button>
      </header>

      {open ? (
        <form
          onSubmit={submit}
          className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
        >
          <fieldset>
            <legend className="mb-1 text-xs text-neutral-500">
              Buckets to combine
            </legend>
            <div className="grid gap-1 sm:grid-cols-2">
              {mergeable.map((bucket) => (
                <label key={bucket.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={picked.includes(bucket.id)}
                    onChange={() => toggle(bucket.id)}
                  />
                  <span className="min-w-0 truncate">{bucket.name}</span>
                </label>
              ))}
            </div>
          </fieldset>

          {picked.length > 1 && !singleKind ? (
            <p className="text-sm text-amber-700 dark:text-amber-400">
              Pick buckets of the same kind. Budget Basics and Budget Categories
              are budgeted differently.
            </p>
          ) : null}

          <fieldset>
            <legend className="mb-1 text-xs text-neutral-500">
              Merge them into
            </legend>
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  checked={mode === "new"}
                  onChange={() => setMode("new")}
                />
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Dining & Drinks"
                  maxLength={80}
                  className="flex-1 rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                />
                <input
                  value={limit}
                  onChange={(event) => setLimit(event.target.value)}
                  placeholder="0"
                  inputMode="decimal"
                  aria-label="Monthly limit"
                  className="w-20 rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                />
              </label>

              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  checked={mode === "existing"}
                  onChange={() => setMode("existing")}
                />
                <select
                  value={targetId}
                  onChange={(event) => setTargetId(event.target.value)}
                  className="flex-1 rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                >
                  <option value="">Choose a bucket...</option>
                  {mergeable
                    .filter((b) => !picked.includes(b.id))
                    .map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                </select>
              </label>
            </div>
          </fieldset>

          {error ? (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
          ) : null}

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={
                pending ||
                picked.length < 1 ||
                (mode === "new" ? name.trim().length === 0 : targetId === "")
              }
              className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
            >
              {pending ? "Merging..." : `Merge ${picked.length || ""}`}
            </button>
            <p className="text-xs text-neutral-500">
              {picked.length > 0
                ? `Removes ${picked.length} bucket${picked.length === 1 ? "" : "s"} and moves everything into the one you choose.`
                : "Pick the buckets that are really one budget line."}
            </p>
          </div>
        </form>
      ) : null}

      {notice ? (
        <Toast
          key={notice.id}
          message={notice.text}
          onDismiss={() => setNotice(null)}
        />
      ) : null}
    </section>
  );
}

/**
 * Monotonic id for the toast key, so each notice remounts and replays its
 * animation. A ref rather than state because this is a counter, not something
 * that drives the UI, and mutating a useState value during render is impure.
 */
function useNoticeId() {
  const counter = useRef(0);
  return () => {
    counter.current += 1;
    return counter.current;
  };
}