-- Per-account daily balances, so /accounts/[id] can chart one account.
--
-- Loans deliberately do NOT get a table here. The loan_payments trigger only ever
-- does `balance -= principal` on insert and `+= principal` on delete, so a loan's
-- balance on any past day is exactly
--
--     current_balance + sum(principal of payments made after that day)
--
-- which loanBalanceSeries() in src/lib/loan-math.ts computes from the ledger.
-- Loan history is therefore complete from the first payment, with nothing to
-- record.
--
-- Accounts have no such ledger. Plaid reports current balances only, and
-- transactions do not determine a balance - a transfer moves one without the
-- other, as do interest and pending authorisations - so the only honest record of
-- an account's balance on a past day is one written that day. The table therefore
-- starts empty, and there is nothing to backfill.
CREATE TABLE "account_balance_snapshots" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "account_balance_snapshots_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"account_id" integer NOT NULL,
	"snapshot_date" date NOT NULL,
	"balance" numeric(18, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_balance_snapshots" ADD CONSTRAINT "account_balance_snapshots_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Also the index serving `where account_id = ? order by snapshot_date`.
CREATE UNIQUE INDEX "account_balance_snapshots_account_date_key" ON "account_balance_snapshots" USING btree ("account_id","snapshot_date");
