"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { BucketCategories } from "@/components/bucket-categories";
import { formatCurrency } from "@/lib/format";

import { NewBucketForm } from "./new-bucket-form";

export type ManagedBucket = {
  id: number;
  kind: "basic" | "category" | "earning";
  name: string;
  categories: string[];
  budgeted: number;
};

export type BucketGroups = {
  basic: ManagedBucket[];
  category: ManagedBucket[];
  earning: ManagedBucket[];
};

const GROUPS: {
  key: keyof BucketGroups;
  title: string;
  description: string;
}[] = [
  {
    key: "earning",
    title: "Earnings",
    description:
      "Income received this month. Deposits are routed here automatically.",
  },
  {
    key: "basic",
    title: "Budget Basics",
    description: "Automatic bills, utilities, savings goals and debt payments.",
  },
  {
    key: "category",
    title: "Budget Categories",
    description: "Flexible spending, grouped into buckets.",
  },
];

/**
 * Every bucket, and every way of changing one.
 *
 * This was three separate places: an "Add bucket" control on each section of the
 * budgets page, a delete `×` on every row there, and the category matcher on the
 * bucket's own page. Nothing about a bucket's *settings* was visible from the page
 * you configure it on, and the budgets page — whose job is comparing figures — was
 * carrying four controls per row that all navigate somewhere else.
 *
 * So configuration lives here and the budgets page is left with the numbers. The
 * budgeted amount is shown but not editable here: it is edited on the budgets page,
 * and two editors for one field is how they drift apart.
 */
export function BucketManager({
  groups,
  availableCategories,
  year,
  month,
}: {
  groups: BucketGroups;
  availableCategories: string[];
  /** Only used to build links into each bucket's transactions. */
  year: number;
  month: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<Record<string, boolean>>({});

  async function call(path: string, init: RequestInit): Promise<boolean> {
    setError(null);
    try {
      const response = await fetch(path, init);
      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        setError(data.error ?? "Something went wrong.");
        return false;
      }
      startTransition(() => router.refresh());
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong.");
      return false;
    }
  }

  const save = (payload: {
    kind: ManagedBucket["kind"];
    name: string;
    categories: string[];
    budgeted: number;
  }) =>
    call("/api/budgets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

  const remove = (id: number) =>
    call(`/api/budgets?id=${id}`, { method: "DELETE" });

  /*
   * Which bucket already claims each category, so the editor can grey out the taken
   * ones and attribute them rather than silently hiding them. Built here rather than
   * on the server because this page already has every bucket and needs no round trip
   * to answer a question about them.
   */
  const claimedBy = new Map<string, string>();
  for (const row of [
    ...groups.basic,
    ...groups.category,
    ...groups.earning,
  ]) {
    // The catch-all must not claim a category, or it would compete with a real
    // bucket and take its transactions.
    const isCatchAll =
      row.kind !== "earning" &&
      row.categories.length === 0 &&
      /everything\s*else|^other$/i.test(row.name);
    if (isCatchAll) continue;
    for (const value of row.categories) {
      if (!claimedBy.has(value)) claimedBy.set(value, row.name);
    }
  }

  return (
    <div className="space-y-6">
      {error ? (
        <p
          role="alert"
          className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
        >
          {error}
        </p>
      ) : null}

      {GROUPS.map((group) => (
        <section key={group.key}>
          <header className="mb-2 flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="font-medium text-neutral-800 dark:text-neutral-200">
                {group.title}
              </h2>
              <p className="text-xs text-neutral-500">{group.description}</p>
            </div>
            <button
              type="button"
              onClick={() =>
                setAdding((current) => ({
                  ...current,
                  [group.key]: !current[group.key],
                }))
              }
              className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
            >
              {adding[group.key] ? "Cancel" : "Add bucket"}
            </button>
          </header>

          {groups[group.key].length === 0 && !adding[group.key] ? (
            <p className="rounded-lg border border-dashed border-neutral-300 p-4 text-center text-sm text-neutral-500 dark:border-neutral-700">
              No buckets here yet.
            </p>
          ) : null}

          <div className="divide-y divide-neutral-100 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {groups[group.key].map((bucket) => (
              <div key={bucket.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link
                      href={`/budgets/${bucket.id}?year=${year}&month=${month + 1}`}
                      className="font-medium hover:underline"
                    >
                      {bucket.name}
                    </Link>
                    <p className="text-xs text-neutral-500">
                      {formatCurrency(bucket.budgeted)} budgeted &middot;{" "}
                      <Link
                        href={`/budgets/${bucket.id}?year=${year}&month=${month + 1}`}
                        className="hover:underline"
                      >
                        transactions
                      </Link>
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => void remove(bucket.id)}
                    aria-label={`Delete ${bucket.name}`}
                    title={`Delete ${bucket.name}`}
                    className="rounded p-0.5 text-neutral-400 hover:bg-neutral-200 hover:text-red-600 disabled:opacity-50 dark:hover:bg-neutral-700"
                  >
                    &times;
                  </button>
                </div>

                {/*
                  Borderless here. On its own page the matcher is a standalone card;
                  nested inside a row that already has a border it read as a box in a
                  box, so `flush` drops its own chrome and it reads as part of the row.
                */}
                <BucketCategories
                  flush
                  name={bucket.name}
                  kind={bucket.kind}
                  categories={bucket.categories}
                  budgeted={bucket.budgeted}
                  availableCategories={availableCategories}
                  claimedBy={Object.fromEntries(claimedBy)}
                />
              </div>
            ))}

            {adding[group.key] ? (
              <div className="px-4 py-3">
                <NewBucketForm
                  kind={group.key}
                  options={availableCategories}
                  claimedBy={claimedBy}
                  disabled={pending}
                  emptyLabel={`Search ${group.title.toLowerCase()} categories`}
                  onCreate={async (payload) => {
                    const ok = await save(payload);
                    if (ok) {
                      setAdding((current) => ({ ...current, [group.key]: false }));
                    }
                    return ok ? new Response() : null;
                  }}
                />
              </div>
            ) : null}
          </div>
        </section>
      ))}
    </div>
  );
}
