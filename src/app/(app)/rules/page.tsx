import type { Metadata } from "next";
import { asc, eq } from "drizzle-orm";

import { RulesEditor, type Rule } from "@/components/rules-editor";
import { requireUser } from "@/lib/auth";
import { getBudgets, getCategories, getLoans } from "@/lib/queries";
import { db, tables } from "@/db";
import { groupRuleRows, getRuleCandidates } from "@/lib/rules";
import { transactionsForRule } from "@/lib/rule-matches";
import type { RuleMatches } from "@/lib/rule-match-types";

export const metadata: Metadata = { title: "Rules · Finance" };

/**
 * Rules live on their own page because they are no longer only about budgets: a
 * rule can pay down a loan, which mints a payment record and moves a debt
 * balance rather than sorting spending. A rule can also do both at once, one
 * step each.
 */
export default async function RulesPage() {
  const user = await requireUser();

  const [rows, buckets, loans, categories, candidates] = await Promise.all([
    db.query.budgetRules.findMany({
      where: eq(tables.budgetRules.userId, user.id),
      orderBy: [
        asc(tables.budgetRules.priority),
        asc(tables.budgetRules.stepOrder),
        asc(tables.budgetRules.id),
      ],
    }),
    getBudgets(user.id),
    getLoans(user.id),
    getCategories(user.id),
    /*
     * One read of the transactions any rule could touch, filtered in JS by the
     * engine's own matcher. Filtering in SQL would be faster and would risk
     * answering a slightly different question than the router does.
     */
    getRuleCandidates(user.id),
  ]);

  const bucketNameById = new Map(buckets.map((b) => [b.id, b.name]));
  const loanNameById = new Map(loans.map((l) => [l.id, l.name]));

  /*
   * One row is one step, so the rows have to be collapsed back into rules before
   * display - otherwise "amount 453.91 pays the loan" and "amount 453.91 goes to
   * Car Payment" render as two separate rules, which is the thing this page is
   * meant to stop doing.
   */
  const rules: Rule[] = groupRuleRows(rows).map((group) => ({
    id: group.id,
    matchType: group.matchType,
    matchValue: group.matchValue,
    steps: group.steps.map((step) => ({
      target: step.target,
      budgetId: step.budgetId,
      budgetName:
        step.budgetId === null
          ? null
          : (bucketNameById.get(step.budgetId) ?? "Deleted bucket"),
      loanId: step.loanId,
      loanName:
        step.loanId === null
          ? null
          : (loanNameById.get(step.loanId) ?? "Deleted loan"),
    })),
  }));

  /*
   * Computed here rather than in the editor: `matchesStoredRule` lives beside the
   * engine in a server-only module, and reimplementing it client-side is how the
   * count on this page starts disagreeing with what saving a rule actually does.
   *
   * Only the capped preview crosses to the client, so the payload is bounded by
   * MATCH_PREVIEW_LIMIT per rule however many transactions each one matches.
   */
  const matchesByRule: Record<string, RuleMatches> = {};
  for (const rule of rules) {
    /*
     * "Already applied" is a question about a bucket, so a rule with no bucket step
     * - a loan step, or an ignore - has nothing to compare against and the column
     * is dropped rather than guessed at. The first bucket step wins, since a rule
     * normally has one.
     */
    const targetBudgetId =
      rule.steps.find((step) => step.target === "bucket")?.budgetId ?? null;
    matchesByRule[String(rule.id)] = transactionsForRule(
      candidates,
      rule,
      targetBudgetId,
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Rules</h1>
        <p className="text-sm text-neutral-500">
          Route transactions automatically, in as many steps as you like. Saving a
          rule applies every step to everything that already matches, not just
          future transactions.
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
        matchesByRule={matchesByRule}
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
          <li>
            Within one rule, every step runs. A loan step and a bucket step both
            apply to the same transaction.
          </li>
        </ul>
      </section>
    </div>
  );
}