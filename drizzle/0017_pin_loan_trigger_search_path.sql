-- `apply_loan_payment_to_balance` referenced `loans` unqualified with no pinned
-- search_path, which Supabase's advisor flags as `function_search_path_mutable`.
--
-- The exposure is a hijack: the trigger resolves `loans` against whatever the
-- caller's search_path happens to be, so a `loans` table earlier on that path
-- would receive the balance update instead of the real one, and the payment would
-- appear to post while the loan never moved. Not exploitable here today - `anon`
-- and `authenticated` have no CREATE anywhere and cannot add a schema - but that
-- is a property of the current grants rather than of this function, and it is the
-- kind of thing that turns exploitable the next time someone enables something.
--
-- `SET search_path = ''` rather than `SET search_path = public`: an empty path is
-- the only value that cannot be widened later by whoever deploys the next
-- migration. It costs one qualifier on the table name, which is the whole point.
-- `now()` still resolves - pg_catalog is implicitly first in every search_path.
--
-- The trigger is not recreated: `CREATE OR REPLACE FUNCTION` keeps the existing
-- trigger bound to it, so the balance logic and the trigger's timing are untouched.
-- Only the name resolution changes.
CREATE OR REPLACE FUNCTION public.apply_loan_payment_to_balance() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.loans
       SET balance = balance - NEW.principal,
           last_accrued_at = NEW.paid_on,
           updated_at = now()
     WHERE id = NEW.loan_id;
    RETURN NEW;
  ELSE
    -- OLD, not NEW: in a DELETE trigger NEW is unassigned, so referencing it
    -- here would make this WHERE match zero rows and silently do nothing.
    UPDATE public.loans
       SET balance = balance + OLD.principal,
           last_accrued_at = OLD.accrued_from,
           updated_at = now()
     WHERE id = OLD.loan_id;
    RETURN OLD;
  END IF;
END;
$$;