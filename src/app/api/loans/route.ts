import "server-only";

import { and, asc, eq, inArray } from "drizzle-orm";

import { db, tables, toNumber } from "@/db";
import { requireUserId } from "@/lib/auth";
import { accruedInterest, projectPayoff } from "@/lib/loan-math";
import { parseDate, parseMoney, parsePercent } from "@/lib/money";

/**
 * Manual loans: debt the user tracks by hand because Plaid cannot see it.
 *
 * Separate from the budgets routes because a loan is not a spending bucket. It
 * has a balance that moves with interest, and a payment is linked to a real bank
 * transaction rather than to a monthly limit.
 *
 * This route never writes `balance` except on an explicit correction. Tagging a
 * payment goes through recordLoanPayment() in @/lib/loan-payments and the
 * database trigger does the arithmetic, so the number can never disagree with
 * the payment history behind it.
 */
export async function GET() {
  const auth = await requireUserId();
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  const loans = await db.query.loans.findMany({
    where: eq(tables.loans.userId, auth.userId),
    orderBy: [asc(tables.loans.name)],
  });

  // Payment history for every loan in one query, so the page does not fan out
  // into an N+1 across the loans.
  const payments = loans.length
    ? await db.query.loanPayments.findMany({
        where: inArray(
          tables.loanPayments.loanId,
          loans.map((loan) => loan.id),
        ),
        orderBy: [asc(tables.loanPayments.paidOn)],
      })
    : [];

  const today = new Date().toISOString().slice(0, 10);

  const result = loans.map((loan) => {
    const balance = toNumber(loan.balance);
    const apr = toNumber(loan.apr);
    const rows = payments.filter((payment) => payment.loanId === loan.id);

    return {
      id: loan.id,
      name: loan.name,
      kind: loan.kind,
      apr,
      principal: toNumber(loan.principal),
      balance,
      paymentAmount:
        loan.paymentAmount === null ? null : toNumber(loan.paymentAmount),
      openedOn: loan.openedOn,
      lastAccruedAt: loan.lastAccruedAt,
      notes: loan.notes,
      /**
       * Interest accrued since the last booking, not yet in `balance`. Shown so
       * a balance that looks stale has an explanation next to it.
       */
      pendingInterest: accruedInterest({
        balance,
        apr,
        fromDate: loan.lastAccruedAt ?? loan.openedOn,
        toDate: today,
      }),
      // null means "no payoff date", either because no payment is set or because
      // the payment does not cover the interest.
      projection: projectPayoff({
        balance,
        apr,
        payment: loan.paymentAmount === null ? null : toNumber(loan.paymentAmount),
      }),
      payments: rows.map((payment) => ({
        id: payment.id,
        transactionId: payment.transactionId,
        amount: toNumber(payment.amount),
        interest: toNumber(payment.interest),
        principal: toNumber(payment.principal),
        overpayment: toNumber(payment.overpayment),
        paidOn: payment.paidOn,
      })),
    };
  });

  return Response.json({ loans: result, today });
}

/** Create a manual loan. Starts owing what it borrowed. */
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

  let input: LoanInput;
  try {
    input = parseLoanInput(body, { requireAll: true });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Invalid input." },
      { status: 400 },
    );
  }

  // parseLoanInput already throws for a missing name/principal when
  // requireAll is set. This narrows the type for the compiler and is a real
  // guard rather than an assertion.
  if (input.name === undefined || input.principal === undefined) {
    return Response.json(
      { error: "name and principal are required." },
      { status: 400 },
    );
  }

  const duplicate = await db.query.loans.findFirst({
    where: and(
      eq(tables.loans.userId, auth.userId),
      eq(tables.loans.name, input.name),
    ),
    columns: { id: true },
  });
  if (duplicate) {
    return Response.json(
      { error: "You already have a loan with that name." },
      { status: 400 },
    );
  }

  const [created] = await db
    .insert(tables.loans)
    .values({
      userId: auth.userId,
      name: input.name,
      kind: input.kind ?? "other",
      apr: (input.apr ?? 0).toFixed(4),
      principal: input.principal.toFixed(2),
      balance: input.principal.toFixed(2),
      paymentAmount:
        input.paymentAmount === undefined || input.paymentAmount === null
          ? null
          : input.paymentAmount.toFixed(2),
      openedOn: input.openedOn ?? new Date().toISOString().slice(0, 10),
      notes: input.notes ?? null,
    })
    .returning({ id: tables.loans.id });

  return Response.json({ loan: created }, { status: 201 });
}

/**
 * Update a loan.
 *
 * `balance` is only written when it is present in the body. Sending it is the
 * user overriding the figure, which is the one case the trigger cannot infer -
 * a lender correction, or a payment made outside this app that was never tagged.
 */
export async function PUT(request: Request) {
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
  const id = Number(raw.id);
  if (!Number.isInteger(id) || id <= 0) {
    return Response.json({ error: "A numeric id is required." }, { status: 400 });
  }

  const owned = await db.query.loans.findFirst({
    where: and(
      eq(tables.loans.id, id),
      eq(tables.loans.userId, auth.userId),
    ),
    columns: { id: true },
  });
  if (!owned) {
    // 404, not 403: do not confirm that someone else's loan id exists.
    return Response.json({ error: "Loan not found." }, { status: 404 });
  }

  let input: LoanInput;
  try {
    input = parseLoanInput(body, { requireAll: false });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Invalid input." },
      { status: 400 },
    );
  }

  const patch: Partial<typeof tables.loans.$inferInsert> = {
    updatedAt: new Date(),
  };

  if (input.name !== undefined) patch.name = input.name;
  if (input.kind !== undefined) patch.kind = input.kind;
  if (input.apr !== undefined) patch.apr = input.apr.toFixed(4);
  if (input.principal !== undefined) {
    patch.principal = input.principal.toFixed(2);
  }
  if (input.paymentAmount !== undefined) {
    patch.paymentAmount =
      input.paymentAmount === null ? null : input.paymentAmount.toFixed(2);
  }
  if (input.openedOn !== undefined) patch.openedOn = input.openedOn;
  if (input.notes !== undefined) patch.notes = input.notes;
  if (input.balance !== undefined) patch.balance = input.balance.toFixed(2);

  const [updated] = await db
    .update(tables.loans)
    .set(patch)
    .where(eq(tables.loans.id, id))
    .returning({
      id: tables.loans.id,
      balance: tables.loans.balance,
      apr: tables.loans.apr,
    });

  return Response.json({ loan: updated });
}

/**
 * Delete a loan. Its payment rows cascade away and the trigger unwinds the
 * balance as they do, so no orphan payment can outlive its loan.
 */
export async function DELETE(request: Request) {
  const auth = await requireUserId();
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  const id = Number.parseInt(
    new URL(request.url).searchParams.get("id") ?? "",
    10,
  );
  if (!Number.isInteger(id) || id <= 0) {
    return Response.json({ error: "A numeric id is required." }, { status: 400 });
  }

  const deleted = await db
    .delete(tables.loans)
    .where(and(eq(tables.loans.id, id), eq(tables.loans.userId, auth.userId)))
    .returning({ id: tables.loans.id });

  if (deleted.length === 0) {
    return Response.json({ error: "Loan not found." }, { status: 404 });
  }

  return Response.json({ deleted: deleted.length });
}

// ---------------------------------------------------------------------------

type LoanInput = {
  name?: string;
  kind?: tables.LoanKind;
  apr?: number;
  principal?: number;
  balance?: number;
  paymentAmount?: number | null;
  openedOn?: string;
  notes?: string | null;
};

const LOAN_KINDS = [
  "auto",
  "personal",
  "student",
  "mortgage",
  "medical",
  "other",
] as const satisfies readonly tables.LoanKind[];

/** $100m is a generous lifetime of debt; anything past it is a typo. */
const MAX_AMOUNT = 100_000_000;

/** 100% APR covers payday-style lending; higher is a typo. */
const MAX_APR = 100;

function parseLoanInput(
  body: unknown,
  opts: { requireAll: boolean },
): LoanInput {
  const raw = (body ?? {}) as Record<string, unknown>;
  const has = (key: string) => key in raw;

  if (opts.requireAll) {
    for (const key of ["name", "principal"]) {
      if (!has(key)) throw new Error(`${key} is required.`);
    }
  }

  const input: LoanInput = {};

  if (has("name")) {
    if (typeof raw.name !== "string" || raw.name.trim().length === 0) {
      throw new Error("name is required.");
    }
    const name = raw.name.trim();
    if (name.length > 80) {
      throw new Error("name must be 80 characters or fewer.");
    }
    input.name = name;
  }

  if (has("kind")) {
    const kind = raw.kind;
    if (
      typeof kind !== "string" ||
      !(LOAN_KINDS as readonly string[]).includes(kind)
    ) {
      throw new Error("kind must be one of the loan types.");
    }
    input.kind = kind as tables.LoanKind;
  }

  if (has("apr")) {
    const apr = parsePercent(raw.apr);
    if (apr === null) {
      throw new Error("apr must be a percentage, for example 5.9 or 5.9%.");
    }
    if (apr > MAX_APR) {
      throw new Error(`apr must be ${MAX_APR} or lower.`);
    }
    input.apr = apr;
  }

  if (has("principal")) {
    const principal = parseMoney(raw.principal);
    if (principal === null) {
      throw new Error("principal must be a non-negative amount.");
    }
    if (principal > MAX_AMOUNT) {
      throw new Error("principal looks too large.");
    }
    input.principal = principal;
  }

  if (has("balance")) {
    const balance = parseMoney(raw.balance);
    if (balance === null) {
      throw new Error("balance must be a non-negative amount.");
    }
    if (balance > MAX_AMOUNT) {
      throw new Error("balance looks too large.");
    }
    input.balance = balance;
  }

  if (has("paymentAmount")) {
    if (raw.paymentAmount === null || raw.paymentAmount === "") {
      input.paymentAmount = null;
    } else {
      const payment = parseMoney(raw.paymentAmount);
      if (payment === null) {
        throw new Error("paymentAmount must be a non-negative amount.");
      }
      if (payment > MAX_AMOUNT) {
        throw new Error("paymentAmount looks too large.");
      }
      input.paymentAmount = payment;
    }
  }

  if (has("openedOn")) {
    const openedOn = parseDate(raw.openedOn);
    if (openedOn === null) {
      throw new Error("openedOn must be a date like 2026-01-31.");
    }
    input.openedOn = openedOn;
  }

  if (has("notes")) {
    if (raw.notes === null || raw.notes === "") {
      input.notes = null;
    } else if (typeof raw.notes !== "string") {
      throw new Error("notes must be text.");
    } else if (raw.notes.trim().length > 500) {
      throw new Error("notes must be 500 characters or fewer.");
    } else {
      input.notes = raw.notes.trim();
    }
  }

  return input;
}