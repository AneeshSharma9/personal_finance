# Budget worksheet

`/budgets/worksheet` — the "After Raise" sheet of a spreadsheet, ported. Reached
from a **Budget worksheet** button on the budgets page.

One saved row per user (`budget_worksheet`, migration 0012), stored separately
from `budgets` on purpose: `budgets` measures what happened to real transactions,
this is what you *intend*. Nothing reconciles the two, and keeping them apart is
what stops one quietly overwriting the other.

## Every figure is derived from the inputs

`computeWorksheet` in `src/lib/budget-worksheet.ts` is pure and holds all of it,
and the client form calls the *same function* the API uses to produce what it
saves — so what you see before saving and what the server stores cannot disagree.
The form keeps inputs as text while typing and normalises on the way into the
maths, because coercing on every keystroke is what eats the trailing `.` of `12.`
and stops a field clearing.

## Two decisions worth knowing about

**Signs are inverted deliberately.** The spreadsheet stores deductions as negative
numbers and subtracts them, so a total is a sum of mixed signs and one missing
minus silently inverts the sheet while every figure still looks plausible.
Everything here is stored and entered as a positive magnitude and subtracted
explicitly.

**Stock is a share of the salary granted on top of it**, so you type the cash
salary and the stock is added: $88,360 plus 12% is **$98,963.20** of total
compensation. Take-home is built from the **cash** salary alone — stock is not money
that lands in an account, so counting it would inflate the figure everything else on
the page is measured against. A test asserts that dropping the stock rate to zero
leaves take-home *identical*, which is what stops a stock-only raise from appearing
to change anything.

This was the first thing built wrong. The spreadsheet's `E8 = E4 + F8` with
`F8 = E8*0.12` reads as though the stock sat *inside* the gross, so it was
implemented as `gross = bills / (1 - rate)` — which for these figures gives a
monthly salary of **$238** against **$2,611** of withholding. Dividing by
`(1 - rate)` instead of multiplying by `(1 + rate)` understates pay by nearly $10k a
year, and drags every other figure down with it, because they are all shares of it.

**The salary solve is opt-in and now asks a coherent question.** Rather than the
spreadsheet's unreconcilable bills-to-salary relationship, it solves for the cash
salary at which take-home exactly covers the bills — `salary = (bills +
deductions) × 12` — which is what the sheet was reaching for: *what do I have to earn
for this plan to work?* Stock is deliberately excluded from that arithmetic, since a
plan that only balances on equity that cannot pay a rent is not a plan. Typed is the
default, because it is what the real figures need.

## Pay periods: the spreadsheet's `x2` is probably wrong

Every withholding and pre-tax figure is entered **per pay period** and multiplied up
to a month. The multiplier is `payPeriodsPerMonth`, defaulting to **26/12** rather
than a flat 2, because biweekly pay is the norm in the US and 26 checks a year is
2.1667 months — a flat 2 models two paychecks that never arrive.

That is not a preference, it is measurable. On the real figures:

| | deductions/mo | take-home | vs recorded $4,510.44 |
| --- | --- | --- | --- |
| 2 (semi-monthly, 24/yr) | $2,611.44 | $4,751.89 | off by **$241.45** |
| 26/12 (biweekly, 26/yr) | $2,829.10 | $4,534.23 | off by **$23.79** |

Biweekly is an order of magnitude closer to what the app has actually recorded as
income, which is why it is the default. Set it to 2 if the pay really is the 1st and
15th.

## Retirement: a separate pot from the goals, by default

The 50/30/20 comparison leaves the 401k and Roth IRA **out** of savings, matching the
spreadsheet, and a checkbox folds them in. Neither is wrong, and the reason they
differ is not accounting pedantry:

- **The goals** (student loans, brokerage, HYSA) are paid out of take-home.
- **The retirement contributions** come out of gross before the money is yours.

Different pots, so folding them together is a presentational choice rather than a
correctness one. It moves what the percentages are measured *against*, and the code
keeps that honest by switching the base too — with retirement counted, the split is
of income-before-savings rather than take-home, so the three shares still add to 100%
either way:

| | base | needs / savings / wants |
| --- | --- | --- |
| goals only (default) | $4,534.23 | 57% / 22% / 21% |
| with retirement | $5,543.05 | 46% / 36% / 17% |

Wants is untouched by the choice, because it is the remainder of take-home either
way. Counting retirement is the more common reading of the rule in public guidance;
leaving it out is the more honest one about what each dollar was actually taken from.

## Select-all on numeric fields

Numeric and short-identifier fields across the app select their whole contents when
focused **or clicked**, via `selectAllProps` in `src/lib/select-all.ts`:

```jsx
<input {...selectAllProps} ... />
```

Both handlers, because neither covers the other. `onFocus` covers arriving by
keyboard — tabbing in never fires a click. `onClick` covers arriving by mouse —
`onFocus` alone fires only when a field *gains* focus, so clicking a field that
already has it just moves the caret. That is what made the first attempt look
intermittent: right-aligned inputs mean clicking the empty space left of the digits
focuses nothing new, so the first click worked and the next one undid it.
`onMouseDown` is avoided deliberately, because selecting there gets undone by the
browser's own caret placement on mouseup.

Deliberately **not** applied to the transaction search box or the category filter
(free text you edit in place — clicking to put a caret after part of a query is the
normal gesture there), the password field (selecting one reveals its length), or
the login email (typed fresh each time, and a login form is the wrong place to be
surprising someone). `tests/select-all.test.mts` asserts the exclusions stay
excluded, because the failure mode is silent: a field without it just behaves like
it always did.

## A note on what the sheet's own figures do not reconcile

`Everything Else` and the ideal-allocation targets depend on cells that are only
legible in a screenshot, so those transcribed values are plausible rather than
confirmed. The salary/stock relationship was confirmed and corrected; if another
total looks wrong, that line is where to look first.

## Testing the save path

Drizzle maps `grossSalary` to `gross_salary` itself, and silently *ignores* an
insert key it does not recognise rather than rejecting it. An early version used
the SQL column names, so every camelCase field saved as zero while the four whose
names happen to match in both (`k401k`, `rent`, `gas`, `hysa`) worked — half the
form saving, silently. A test now asserts every field in the list is a real field
on the table, which needs no database.
