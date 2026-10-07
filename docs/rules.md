# Rules

`/rules` manages automatic routing for **both** buckets and loans. Rules used to
live under Budgets, which was wrong as soon as a rule could pay down a loan: that
is a different kind of write (it mints a payment record and moves a debt balance)
from sorting spending into a bucket.

`GET|PUT /api/rules`, `POST /api/rules`, `DELETE /api/rules?id=`.

## A rule is a match plus steps

A rule is **one match and any number of steps**. Each step sends matching
transactions somewhere different, and they do not compete:

```
Match: amount 453.91
  1. send to  → Mazda 3 Loan        (records a payment, moves the balance)
  2. send to  → Car Payment bucket  (sets budget_id)
```

Both run. The loan write and the bucket write touch different columns, so the
same transaction ends up recorded as a car-loan payment *and* counted as car
spending — which is the point of expressing them as one rule.

Each *step* still satisfies `budget_rules_one_target_check` — exactly one of
`budget_id`, `loan_id`, `exclude` — so no individual row is ambiguous; only the
rule as a whole has several targets.

This replaced a one-target design where the table was unique on
`(user_id, match_type, match_value)` and saving was an upsert on that key. Adding
a second target therefore **replaced** the first instead of joining it, so a
"pay the car loan" rule silently became a "spend on car payments" rule.

## One row is one (value, step) pair

Every row in `budget_rules` belongs to a `rule_group`, and the rule *is* that
group:

```
rule_group  A   match_type merchant   match_value uas                     → Student Loans
rule_group  A   match_type merchant   match_value uas                     → Ignore
rule_group  A   match_type merchant   match_value us department of education → Student Loans
rule_group  A   match_type merchant   match_value us department of education → Ignore
```

Two values × two steps is four rows. Rows sharing a group are one rule, and
`groupRuleRows` collapses them back into `{matchValues, steps}` for display.

**Why one row per (value, step) and not an array of values on the row:** it means
every row still matches exactly one thing and does exactly one thing. The routing
engine, the undo path and the one-target constraint all read rows individually and
carry on unchanged — no matcher anywhere has to learn what a list of values is, and
the existing unique index
`(user_id, match_type, match_value, target)` already prevents duplicates for
free.

**Why a group id rather than the match:** identity cannot be the match once the
match is editable. A rule's identity was `(match_type, match_value)`, so growing a
rule from one value to two looked like deleting one rule and creating two. The
group is generated server-side, because identity is not something a user types and
a hand-written one is one typo away from silently merging two unrelated rules.
Migration `0015` groups every existing rule so nothing changes underneath.

`ruleKey` falls back to `(match_type, match_value)` for a row with no group, so a
row written by a path that forgot the column still reads as the rule it was rather
than as its own single-value rule.

## A rule can match on several values

```
Match: merchant contains "uas" or "us department of education"
  1. send to  → Student Loans
```

The alternatives are **OR'd**: a transaction is in scope when it matches any of
them. They work for all three match types, and the form shows an `or` between the
fields because "several inputs" otherwise reads as several conditions.

Consequences worth knowing:

- **Adding an alternative applies it to history**, like any other save.
- **Removing one un-claims what only it matched.** The transactions that a
  surviving alternative still matches are left alone, because they are still
  claimed by a row that is still there — the same check that keeps a hand-tagged
  loan payment safe.
- **The step is written once.** Two alternatives with the same target store the
  step twice, because a transaction matching only the second one still has to get
  it — but the rules list shows one rule with one numbered list of steps.
- Values are normalised before de-duplication (`KFC` and `kfc` are one
  alternative, not two rows each reporting every match), and `600` and `600.00`
  are still one amount.

## Editing

Each rule has an **edit** button that loads its match and steps back into the same
form, so values and steps can be added, removed, reordered, or retargeted.
Removing a step or an alternative is not just "stop doing this going forward" —
see [Undo](#undoing-a-step).

## Match types

| Type | Matches | Notes |
|---|---|---|
| `merchant` | Merchant or raw description contains the text | Case-insensitive, substring not prefix |
| `category` | A Plaid category, or any child of it | Boundary-aware: `FOOD` does not claim `FASTFOOD_RESTAURANT` |
| `amount` | That exact figure | Magnitude, so direction-agnostic; `600` and `600.00` are one rule |

## Precedence

Between rules, for which bucket wins:

1. Exact amount.
2. Merchant contains.
3. Category - but your own category override wins over Plaid's suggestion.
4. The catch-all bucket.

Within one rule there is no precedence: every step runs.

### Budget groups are not cosmetic

The `Which rule wins` list on `/budgets` is about *rules*. Between *buckets*,
there is a precedence people do not expect: `loadRuleSet` orders buckets by
`budget_kind` first, and Postgres orders an enum by its declaration order —
`basic`, `category`, `earning`. So **every Budget Basics bucket is tested before
every Budget Categories bucket**, and because matching is prefix-based on the
underscore boundary, a Basics bucket on `LOAN_PAYMENTS` claims
`LOAN_PAYMENTS_CAR_PAYMENT` before a Categories bucket on `LOAN_PAYMENTS` ever
sees it.

That is why having both "Loan Payments Car Payment" (Basics) and "Savings &
Debt" (Categories) was quietly redundant rather than additive. It is not written
down anywhere in the UI, and it is a side effect of reusing the display group as
the sort key.

## Saving a rule applies it to history

The sync-time engine (`applyBudgetRules`) only fills in transactions with **no**
assignment, which is what makes a manual assignment survive later syncs. That is
also why a new rule used to look broken: every transaction it matched had already
been assigned.

Saving a rule therefore applies every step to every matching transaction,
overwriting existing assignments, and the response reports `applied` — one
`{moved, matched, target}` per **row**, so the page can say what each one did. A
rule that silently matched nothing would be indistinguishable from a working one.

With alternatives in play that is one entry per (value, step) pair, so a
two-value rule reports its step twice. That is what it did: the two passes reach
different transactions, and the counts still add up per target.

The one thing it does **not** do is create a rule from a per-transaction
reassignment; those remain one-off.

## Loan steps

A step aimed at a loan tags matching outgoing transactions as payments, creating
`loan_payments` rows. Backfill runs in **ascending date order** on purpose: each
insert advances the loan's accrual cursor, so applying newest-first would charge
a year of interest against the first payment and none against the rest.

Runs after a sync (`applyLoanRules`), non-fatally and separately from bucket
routing, and skips transactions that already have a payment.

## Undoing a step

Removing a step undoes what it did, because a step that wrote loan payments has
already moved a debt balance — leaving those behind would leave the rule's
history asserting something untrue. Deleting a rule undoes all of its steps.

Removing an **alternative** is the same operation on a subset: the rule and its
steps survive, but the transactions only that alternative matched stop being
claimed. The candidate set is therefore every value whose writes might need
undoing — surviving *and* just-dropped — and the "still wanted by something" check
below is what stops a surviving alternative's transactions from being reverted
along with the dropped one's.

The writes are not always the step's alone, so each one is checked against
everything that still wants it and left alone if so (`kept` in the response):

| Step | Undo | Left alone when |
|---|---|---|
| bucket | clears `budget_id` | another step or rule still targets that bucket |
| ignore | clears `excluded` | the row is a credit/loan balance movement, which the routing engine excludes for its own reasons |
| loan | deletes the `loan_payments` row | the payment has `source = 'manual'`, or another rule still targets that loan |

Clearing `budget_id` leaves the transaction **undecided** rather than repointed.
`applyBudgetRules` only fills nulls, so the next routing pass decides from
whatever else matches; if nothing does, the row visibly falls to the catch-all
instead of quietly staying where it was.

`loan_payments.source` is what keeps an undo from deleting a tag the user set by
hand on the transactions page. Without it the two are indistinguishable rows. It
has **no database default**, so an insert has to say which it is — the column
used to default to `'manual'`, which meant every row written before it existed was
labelled as a hand-tag and no undo ever removed any of them. See
`drizzle/0010_silent_veda.sql`, which relabels those rows and drops the default.

## Seeing what a rule is affecting

Each rule on `/rules` carries a count of the transactions it matches, and a
collapsed list behind it: date, description, amount, and whether the rule has
already routed it.

**The count comes from the engine's own matcher.** `transactionsForRule` calls the
same `matchesStoredRule` that `applyRulesToHistory` does, so the number here and
what saving a rule actually does cannot disagree — which is the only property worth
having. A rule list that filtered in SQL would be faster and might well answer a
slightly different question, and a confidently wrong count is worse than none.

For a rule with alternatives the count is over all of them, asking the matcher
once per value. Joining the values into one string and asking for a substring
would match nothing at all and would look exactly like a rule that had stopped
working.

Because that matcher lives beside the routing engine in a `server-only` module, the
matching runs on the server and only the capped preview crosses to the client.
Nothing is recomputed in the browser, which is also why there is no second
implementation to drift.

Three details that are load-bearing rather than decorative:

- **Excluded rows are listed, and labelled "ignored".** They are excluded from
  budgeting but still *match*, and a rule whose every match is ignored is exactly
  the case this view exists to explain. All three of the ignore rules in the seed
  data are in that position.
- **"Applied" versus "would move"** is what makes a long list worth reading. Without
  it you cannot tell a working rule from one that has not been re-run.
- **The list is capped at 20, the count is not.** A merchant rule from three years
  ago matches hundreds of rows; the question being asked is usually "is this rule
  doing what I think", which the most recent twenty answer.

A rule with no bucket step (a loan step, or an ignore) has no bucket to be "applied"
to, so that column is dropped rather than guessed at.

The trade-off is O(rules × transactions) in memory per page load: candidates are read
once and filtered per rule in JS rather than per rule in SQL. For a personal
finance app with thousands of transactions that is the right way round — the page is
responsive and, more importantly, it cannot disagree with the engine.
