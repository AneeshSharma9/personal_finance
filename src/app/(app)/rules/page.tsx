import type { Metadata } from "next";

import { RulesEditor, type Rule } from "@/components/rules-editor";
import { requireUser } from "@/lib/auth";
import { getBudgets, getCategories, getLoans } from "@/lib/queries";
import { db, tables } from "@/db";
import { asc, eq } from "drizzle-orm";

export const metadata: Metadata = { title: "Rules · Finance" };

/**
 * Rules live on their own page because they are no longer only about budgets: a
 * rule can pay down a loan, which mints a payment record and moves a debt
 * balance rather than sorting spending.
 */
export default async function RulesPage() {
  const user = await requireUser();

  const [rows, buckets, loans, categories] = await Promise.all([
    db.query.budgetRules.findMany({
      where: eq(tables.budgetRules.userId, user.id),
      orderBy: [asc(tables.budgetRules.priority), asc(tables.budgetRules.id)],
    }),
    getBudgets(user.id),
    getLoans(user.id),
    getCategories(user.id),
  ]);

  const bucketNameById = new Map(buckets.map((b) => [b.id, b.name]));
  const loanNameById = new Map(loans.map((l) => [l.id, l.name]));

  const rules: Rule[] = rows.map((rule) => ({
    id: rule.id,
    matchType: rule.matchType,
    matchValue: rule.matchValue,
    target: rule.loanId === null ? "bucket" : "loan",
    budgetName:
      rule.budgetId === null
        ? null
        : (bucketNameById.get(rule.budgetId) ?? "Deleted bucket"),
    loanName:
      rule.loanId === null
        ? null
        : (loanNameById.get(rule.loanId) ?? "Deleted loan"),
    priority: rule.priority,
    active: rule.active,
  }));

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Rules</h1>
        <p className="text-sm text-neutral-500">
          Route transactions automatically. Saving a rule applies it to
          everything that already matches, not just future ones.
        </p>
      </header>

      <RulesEditor
        initialRules={rules}
        buckets={buckets.map((bucket) => ({
          id: bucket.id,
          name: bucket.name,
          kind: bucket.budgetKind,
        }))}
        loans={loans.map((loan) => ({ id: loan.id, name: loan.name }))}
        categories={categories}
      />

      <section className="rounded-lg border border-neutral-200 p-4 text-sm text-neutral-600 dark:border-neutral-800 dark:text-neutral-400">
        <h2 className="mb-2 font-medium text-neutral-700 dark:text-neutral-200">
          Which rule wins
        </h2>
        <ul className="list-disc space-y-1 pl-4">
          <li>An exact amount beats everything else.</li>
          <li>A merchant rule beats a category rule.</li>
          <li>
            Your own category choice, if you set one, beats Plaid&apos;s
            suggestion.
          </li>
          <li>
            Anything still unclaimed lands in the catch-all bucket.
          </li>
        </ul>
      </section>
    </div>
  );
}