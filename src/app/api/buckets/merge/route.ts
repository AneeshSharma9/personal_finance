import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { db, tables } from "@/db";
import { requireUserId } from "@/lib/auth";
import { applyBudgetRules } from "@/lib/budget-engine";

/**
 * Combine several buckets into one.
 *
 * The case this exists for: two buckets that are really one thing, where
 * transactions were being moved between them by hand. "Food And Drink Coffee"
 * and "Dining & Drinks" are the same budget line to the person paying it.
 *
 * Everything happens in one transaction, so a failure part-way leaves nothing
 * half-merged.
 */
export async function POST(request: Request) {
  const auth = await requireUserId();
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }

  const raw = (body ?? {}) as Record<string, unknown>;

  const sourceIds = Array.isArray(raw.sourceIds)
    ? raw.sourceIds.map(Number).filter((id) => Number.isInteger(id) && id > 0)
    : [];
  const uniqueSources = [...new Set(sourceIds)];

  if (uniqueSources.length === 0) {
    return Response.json(
      { error: "Choose at least one bucket to merge." },
      { status: 400 },
    );
  }

  let targetId: number | null = null;
  let targetName: string | null = null;
  let targetKind: "basic" | "category" = "category";
  let monthlyLimit: number | null = null;

  if (raw.targetId !== undefined && raw.targetId !== null && raw.targetId !== "") {
    targetId = Number(raw.targetId);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      return Response.json({ error: "A numeric targetId is required." }, { status: 400 });
    }
  } else {
    if (typeof raw.name !== "string" || raw.name.trim().length === 0) {
      return Response.json({ error: "A name is required." }, { status: 400 });
    }
    targetName = raw.name.trim().slice(0, 80);
    if (
      raw.kind !== undefined &&
      raw.kind !== null &&
      raw.kind !== "basic" &&
      raw.kind !== "category"
    ) {
      return Response.json({ error: "kind must be basic or category." }, { status: 400 });
    }
    targetKind = raw.kind ?? "category";
    if (raw.monthlyLimit !== undefined && raw.monthlyLimit !== null) {
      const limit = Number(raw.monthlyLimit);
      if (!Number.isFinite(limit) || limit < 0) {
        return Response.json(
          { error: "monthlyLimit must be a non-negative number." },
          { status: 400 },
        );
      }
      monthlyLimit = limit;
    }
  }

  if (targetId !== null && uniqueSources.includes(targetId)) {
    return Response.json(
      { error: "A bucket cannot be merged into itself." },
      { status: 400 },
    );
  }

  try {
    const result = await db.transaction(async (tx) => {
      // Ownership check on everything at once, before any write.
      const owned = await tx.query.budgets.findMany({
        where: and(
          eq(tables.budgets.userId, auth.userId),
          inArray(
            tables.budgets.id,
            targetId === null ? uniqueSources : [targetId, ...uniqueSources],
          ),
        ),
        columns: {
          id: true,
          name: true,
          categories: true,
          budgetKind: true,
          monthlyLimit: true,
          sortOrder: true,
        },
      });

      const byId = new Map(owned.map((b) => [b.id, b]));
      for (const id of uniqueSources) {
        if (!byId.has(id)) throw new MergeError("A bucket to merge was not found.", 404);
      }

      const sources = uniqueSources.map((id) => byId.get(id)!);

      /*
       * Earnings rows are actual income, not a spending line to be tidied up,
       * and merging two of them would mean double-counting someone's pay. Refuse
       * rather than quietly produce a wrong total.
       */
      const kinds = new Set([
        ...sources.map((b) => b.budgetKind),
        ...(targetId !== null ? [byId.get(targetId)!.budgetKind] : []),
      ]);
      if (kinds.has("earning")) {
        throw new MergeError(
          "Earnings cannot be merged. Income is counted, not budgeted.",
          400,
        );
      }
      if (kinds.size > 1) {
        throw new MergeError(
          "Can only merge buckets of the same kind.",
          400,
        );
      }

      // Resolve the destination, reusing an existing bucket if one was named.
      // Held as a const downstream so it is non-nullable for the rest of the
      // transaction; only id and name are ever read after this point.
      const namedTarget = targetId === null ? null : byId.get(targetId)!;
      let target: { id: number; name: string } | null = namedTarget
        ? { id: namedTarget.id, name: namedTarget.name }
        : null;
      if (!target) {
        const [created] = await tx
          .insert(tables.budgets)
          .values({
            userId: auth.userId,
            budgetKind: targetKind,
            name: targetName!,
            // Deliberately empty. A merged bucket spans several categories, and
            // the explicit rules below cover each source one instead - leaving an
            // implicit list here would double-claim them.
            categories: [],
            monthlyLimit: (monthlyLimit ?? 0).toFixed(2),
            // Sit where the first source sat rather than jumping to the end.
            sortOrder: Math.min(...sources.map((b) => b.sortOrder)),
          })
          .returning({ id: tables.budgets.id, name: tables.budgets.name });
        target = created;
      }

      if (!target) {
        throw new MergeError("Could not create the merged bucket.", 500);
      }
      const destination = target;

      // 1. Point every transaction at the destination.
      const moved = await tx
        .update(tables.transactions)
        .set({ budgetId: destination.id, updatedAt: new Date() })
        .where(inArray(tables.transactions.budgetId, uniqueSources))
        .returning({ id: tables.transactions.id });

      /*
       * 2. Repoint rules instead of letting them cascade away.
       *
       * budget_rules.budget_id is ON DELETE CASCADE, so deleting a source bucket
       * would silently destroy any rule pointing at it - the same trap that eats
       * loan rules when a loan is deleted.
       */
      const repointed = await tx
        .update(tables.budgetRules)
        .set({ budgetId: destination.id })
        .where(inArray(tables.budgetRules.budgetId, uniqueSources))
        .returning({ id: tables.budgetRules.id });

      /*
       * 3. Give the destination a claim on each source category.
       *
       * Without this, merging would be a one-off cleanup: the next sync would
       * route new transactions straight back to a category with no bucket, or to
       * the catch-all, and the tidying would undo itself.
       *
       * Skipped when a rule already claims that category, so re-running a merge
       * cannot stack duplicates on the (userId, matchType, matchValue) index.
       */
      const categories = [
        ...new Set(sources.flatMap((b) => b.categories)),
      ];
      let rulesCreated = 0;
      for (const category of categories) {
        const existing = await tx.query.budgetRules.findFirst({
          where: and(
            eq(tables.budgetRules.userId, auth.userId),
            eq(tables.budgetRules.matchType, "category"),
            eq(tables.budgetRules.matchValue, category),
          ),
          columns: { id: true },
        });
        if (existing) continue;
        await tx.insert(tables.budgetRules).values({
          userId: auth.userId,
          budgetId: destination.id,
          matchType: "category",
          matchValue: category,
        });
        rulesCreated += 1;
      }

      // 4. Remove the emptied sources.
      await tx
        .delete(tables.budgets)
        .where(inArray(tables.budgets.id, uniqueSources));

      return {
        target: { id: destination.id, name: destination.name },
        merged: sources.map((b) => b.name),
        transactionsMoved: moved.length,
        rulesRepointed: repointed.length,
        rulesCreated,
        categories,
      };
    });

    // Route anything that was sitting unassigned so the merge shows its effect.
    try {
      await applyBudgetRules(auth.userId);
    } catch (error) {
      console.error(
        "[merge-buckets] post-merge routing failed:",
        error instanceof Error ? error.message : error,
      );
    }

    return Response.json({ ...result, ok: true });
  } catch (error) {
    if (error instanceof MergeError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    console.error(
      "[merge-buckets] failed:",
      error instanceof Error ? error.message : error,
    );
    return Response.json({ error: "Could not merge those buckets." }, { status: 500 });
  }
}

/** A failure to report with a specific status, rather than a bare 500. */
class MergeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "MergeError";
  }
}