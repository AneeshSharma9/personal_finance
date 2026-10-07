# Documentation

Design notes for Personal Finance, one file per feature. These record **what was
decided and why** — including the reasoning behind choices that look wrong until
you know the history, and the bugs a decision was fixing.

Setup, deployment and the stack are in the [README](../README.md). Everything
here assumes you have the app running.

## Start here

| | |
|---|---|
| [Architecture](architecture.md) | The build plan this implements: scope, Plaid constraints, data model, API surface, build phases |
| [Security](security.md) | Access control, RLS and the trigger function, what Supabase's advisor will keep reporting |
| [Roadmap](roadmap.md) | Known issues and what is not built yet |

## Features

| | |
|---|---|
| [Plaid](plaid.md) | Trial-plan limits to design around; adding a bank |
| [Accounts](accounts.md) | Linking, holdings in two presentations |
| [Transactions](transactions.md) | Filtering, re-categorising, the details dialog |
| [Budgets](budgets.md) | Buckets, categories, routing, the unassigned queue, the remainder bucket, the month strip |
| [Budget worksheet](budget-worksheet.md) | The 50/30/20 planner and its two debatable decisions |
| [Cash flow](cash-flow.md) | The Sankey diagram, pan and zoom |
| [Rules](rules.md) | Match types, several values at once, precedence, steps, undo |
| [Manual loans](loans.md) | Loans Plaid does not cover; interest; the balance trigger |
| [Dashboard](dashboard.md) | Which chart, and why |
| [Net worth](net-worth.md) | Where the two kinds of history come from |
| [Webhooks](webhooks.md) | Signature verification and what each event triggers |

## Conventions these notes assume

- **Code comments explain *why*.** The docs explain the shape of a feature; the
  comment on the line explains the decision. Both exist because "why" is the part
  that rots.
- **A note that only makes sense once you know the bug it fixed is still worth
  writing.** Several sections here are a post-mortem in paragraph form.
- **Cross-references are file-relative.** `[Undo](rules.md#undoing-a-step)`.