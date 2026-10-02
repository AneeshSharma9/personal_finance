ALTER TABLE "loan_payments" ADD COLUMN "accrued_from" date NOT NULL;--> statement-breakpoint
-- Keep loans.balance consistent with the payment ledger.
--
-- This lives in the database on purpose. The app adjusts the balance in exactly
-- one place, but a transaction can be deleted without the app asking: sync
-- removes rows Plaid reports as gone (src/lib/plaid/sync.ts deletes the row).
-- A tagged payment must then return its money to the loan, and an API-layer
-- adjustment would never see it happen.
--
-- balance -= principal, and balance += principal on delete, are exact inverses,
-- so un-tagging a payment restores the balance to the cent. Nothing is clamped
-- at zero here; `splitPayment` in src/lib/loan-math.ts is responsible for
-- capping `principal` so the balance can never be driven negative.
--
-- last_accrued_at is rewound to accrued_from on delete, otherwise the reverted
-- stretch of interest would never be counted again.
CREATE OR REPLACE FUNCTION apply_loan_payment_to_balance() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE loans
       SET balance = balance - NEW.principal,
           last_accrued_at = NEW.paid_on,
           updated_at = now()
     WHERE id = NEW.loan_id;
    RETURN NEW;
  ELSE
    -- OLD, not NEW: in a DELETE trigger NEW is unassigned, so referencing it
    -- here would make this WHERE match zero rows and silently do nothing.
    UPDATE loans
       SET balance = balance + OLD.principal,
           last_accrued_at = OLD.accrued_from,
           updated_at = now()
     WHERE id = OLD.loan_id;
    RETURN OLD;
  END IF;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS loan_payments_balance ON loan_payments;--> statement-breakpoint
CREATE TRIGGER loan_payments_balance
AFTER INSERT OR DELETE ON loan_payments
FOR EACH ROW EXECUTE FUNCTION apply_loan_payment_to_balance();
