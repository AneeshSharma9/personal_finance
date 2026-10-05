import type { Metadata } from "next";
import Link from "next/link";

import { requireUser } from "@/lib/auth";
import { WORKSHEET_DEFAULTS } from "@/lib/budget-worksheet";
import { getBudgetWorksheet } from "@/lib/queries";
import { BackLink } from "@/components/back-link";
import { BudgetWorksheetForm } from "@/components/budget-worksheet-form";

export const metadata: Metadata = { title: "Budget worksheet · Finance" };

/**
 * The budget worksheet, ported from a spreadsheet.
 *
 * One standing plan rather than a per-month record, and separate from `/budgets`
 * on purpose: `budgets` measures what actually happened to real transactions,
 * this is what you *intend*. Nothing reconciles the two, and keeping them apart is
 * what stops one quietly overwriting the other.
 */
export default async function WorksheetPage() {
  const user = await requireUser();
  const saved = await getBudgetWorksheet(user.id);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Budget worksheet</h1>
          <p className="text-sm text-neutral-500">
            What you intend, working from gross pay down.
          </p>
        </div>
        <BackLink href="/budgets">Budgets</BackLink>
      </header>

      {/*
        A plan, not a forecast: it says nothing about what will happen, so it is
        kept visibly separate from the budgets page that measures real spending.
      */}
      <p className="text-sm text-neutral-500">
        This is your plan. It is not compared against the{" "}
        <Link href="/budgets" className="transition-colors hover:text-neutral-900 dark:hover:text-neutral-100">
          budgets page
        </Link>
        , which measures what your accounts actually did.
      </p>

      <BudgetWorksheetForm saved={saved ?? WORKSHEET_DEFAULTS} />
    </div>
  );
}