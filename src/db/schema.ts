import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const plaidEnvironment = pgEnum("plaid_environment", [
  "sandbox",
  "production",
]);

/**
 * Item status mirrors Plaid's item.status plus the states that only matter
 * locally. Plaid only reports "healthy" / "login_required" /
 * "pending_expiration" / "user_locked" / "item_locked" / "revoked" /
 * "error" / "pending_disconnect"; `requires_update` is how we remember that a
 * login_required item still needs a Link update-mode run.
 */
export const itemStatus = pgEnum("item_status", [
  "healthy",
  "login_required",
  "requires_update",
  "pending_expiration",
  "user_locked",
  "item_locked",
  "revoked",
  "error",
  "pending_disconnect",
]);

/**
 * Plaid account.type. `investment` accounts are de-emphasised: for those we
 * read value from holdings, not from `current_balance`, to avoid double
 * counting the brokerage cash sweep (PLANNED_ARCHITECTURE.md 5.6).
 */
export const accountType = pgEnum("account_type", [
  "depository",
  "credit",
  "loan",
  "investment",
  "other",
]);

export const accountSubtype = pgEnum("account_subtype", [
  "checking",
  "savings",
  "money market",
  "certificate of deposit",
  "credit card",
  "student",
  "mortgage",
  "personal",
  "auto",
  "home equity",
  "brokerage",
  "401k",
  "ira",
  "roth ira",
  "other",
]);

export const manualAccountKind = pgEnum("manual_account_kind", [
  "asset",
  "liability",
]);

export const liabilityKind = pgEnum("liability_kind", [
  "credit",
  "student",
  "mortgage",
  "other",
]);

/**
 * What a manual loan is for.
 *
 * Separate from `liabilityKind` because that enum describes Plaid liabilities
 * (which are pinned to a synced account) while this describes loans the user
 * tracks by hand.
 */
export const loanKind = pgEnum("loan_kind", [
  "auto",
  "personal",
  "student",
  "mortgage",
  "medical",
  "other",
]);

/**
 * Where a loan payment came from.
 *
 * Recorded because undoing a rule needs to tell the two apart. When a rule step
 * says "this pays the car loan" is removed, only payments the *rule* created
 * should be un-tagged; one the user attached by hand on the transactions page is
 * their decision and has to survive. Without this the two are indistinguishable
 * and the safe-looking undo quietly deletes a deliberate tag along with the
 * interest split it recorded.
 */
export const loanPaymentSource = pgEnum("loan_payment_source", [
  /** Tagged by the user on the transactions page. */
  "manual",
  /** Created by a rule step matching the transaction. */
  "rule",
]);

export const recurringFrequency = pgEnum("recurring_frequency", [
  "weekly",
  "monthly",
  "quarterly",
  "annually",
  "irregular",
]);

export const investmentTxnType = pgEnum("investment_txn_type", [
  "buy",
  "sell",
  "dividend",
  "interest",
  "contribution",
  "withdrawal",
  "fee",
  "other",
]);

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

/**
 * Single-user by design (see ALLOWED_EMAILS). `users.id` is a text UUID that
 * mirrors the Supabase Auth user id, so there is no separate identity to join
 * against. Auth owns credentials; this table owns app data.
 */
export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// items  (one row = one Plaid Item = one bank login = one Trial-plan slot)
// ---------------------------------------------------------------------------

export const items = pgTable(
  "items",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    plaidItemId: text("plaid_item_id").notNull(),
    /** AES-256-GCM ciphertext. Losing this loses the Item AND its Trial slot. */
    accessTokenEncrypted: text("access_token_encrypted").notNull(),
    institutionName: text("institution_name"),
    institutionId: text("institution_id"),
    /** /transactions/sync cursor. Only persisted after the batch is committed. */
    cursor: text("cursor"),
    status: itemStatus("status").notNull().default("healthy"),
    /** Set when Plaid reports ITEM_LOGIN_REQUIRED so we offer Link update mode. */
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    environment: plaidEnvironment("environment").notNull().default("sandbox"),
    consentedAt: timestamp("consented_at", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // One Plaid Item per Plaid Item, across the whole app.
    uniqueIndex("items_plaid_item_id_key").on(t.plaidItemId),
    index("items_user_id_idx").on(t.userId),
    index("items_status_idx").on(t.status),
  ],
);

// ---------------------------------------------------------------------------
// accounts
// ---------------------------------------------------------------------------

export const accounts = pgTable(
  "accounts",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    itemId: integer("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    plaidAccountId: text("plaid_account_id").notNull(),
    name: text("name").notNull(),
    officialName: text("official_name"),
    mask: text("mask"),
    type: accountType("type").notNull(),
    subtype: accountSubtype("subtype"),
    /**
     * Sign convention (PLANNED_ARCHITECTURE.md 6): Plaid reports debt balances
     * as positive amounts owed. We keep the raw Plaid sign for `credit` and
     * `loan` accounts and derive net-worth signs at read time, so we never
     * have to guess which way a stored number points.
     */
    currentBalance: numeric("current_balance", {
      precision: 18,
      scale: 4,
    }).notNull(),
    availableBalance: numeric("available_balance", { precision: 18, scale: 4 }),
    isoCurrencyCode: varchar("iso_currency_code", { length: 3 })
      .notNull()
      .default("USD"),
    /** /accounts/get cache time - lets us show how stale a balance is. */
    balanceUpdatedAt: timestamp("balance_updated_at", { withTimezone: true }),
    plaidUpdatedAt: timestamp("plaid_updated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("accounts_plaid_account_id_key").on(t.plaidAccountId),
    index("accounts_item_id_idx").on(t.itemId),
    index("accounts_type_idx").on(t.type),
  ],
);

// ---------------------------------------------------------------------------
// budgets
// ---------------------------------------------------------------------------

/**
 * Which of the two budget groups a row belongs to.
 *
 * Modelled after Rocket Money's layout:
 *  - `basic`    automatic obligations: bills, utilities, subscriptions, savings
 *               goals, debt payments. Predictable and usually fixed amounts.
 *  - `category` flexible day-to-day spending, grouped into a handful of buckets
 *               (Groceries, Dining & Drinks, Everything Else).
 *  - `earning`  income. Tracked separately from spending so "actual" income can
 *               be compared against what was budgeted.
 */
export const budgetKind = pgEnum("budget_kind", [
  "basic",
  "category",
  "earning",
]);

export const budgets = pgTable(
  "budgets",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    budgetKind: budgetKind("budget_kind").notNull().default("category"),
    /** Display label, e.g. "Bills & Utilities". Free-form and user-owned. */
    name: text("name").notNull(),
    /**
     * Plaid categories this row's "actual" is measured against, e.g.
     * ["FOOD_AND_DRINK", "GENERAL_MERCHANDISE"]. Empty means the row is
     * display-only (a fixed bill like rent, which has no Plaid category), so its
     * actual stays 0 until a category is chosen.
     *
     * An array rather than a single value because a real spending bucket is
     * rarely one category. "Weekend" is DINING_AND_DRINK *and* ENTERTAINMENT;
     * "Amazon" is GENERAL_MERCHANDISE and ONLINE_SHOPPING. With one slot per
     * bucket the only options were a vague name or several buckets competing for
     * the same transactions, and two buckets sharing a category meant only the
     * first ever matched while the second read $0 forever with no error.
     *
     * Separate from `name` so the user can call a row "Weekend" while still
     * measuring it against DINING_AND_DRINK.
     */
    categories: text("categories")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** The "Budgeted" column. */
    monthlyLimit: numeric("monthly_limit", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
    /** Manual ordering within a group; lower comes first. */
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Uniqueness is per group, so "Bills & Utilities" can exist under both
    // Budget Basics and Budget Categories.
    uniqueIndex("budgets_user_kind_name_key").on(t.userId, t.budgetKind, t.name),
    index("budgets_user_kind_idx").on(t.userId, t.budgetKind),
  ],
);

// ---------------------------------------------------------------------------
// transactions
// ---------------------------------------------------------------------------

export const transactions = pgTable(
  "transactions",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    plaidTransactionId: text("plaid_transaction_id").notNull(),
    /**
     * Plaid signs are positive for money OUT and negative for money IN
     * (PLANNED_ARCHITECTURE.md 6). We store Plaid's sign verbatim so the column
     * always matches what Plaid returns; UI converts for display.
     */
    amount: numeric("amount", { precision: 18, scale: 4 }).notNull(),
    date: date("date").notNull(),
    authorizedDate: date("authorized_date"),
    merchantName: text("merchant_name"),
    name: text("name"),
    /** Plaid category primary. */
    plaidCategoryPrimary: text("plaid_category_primary"),
    plaidCategoryDetailed: text("plaid_category_detailed"),
    /** User's choice. Falls back to plaid_category_primary when null. */
    categoryOverride: text("category_override"),
    /**
     * Excluded from budgeting entirely: not counted as income, not counted as
     * spending, not assigned a bucket.
     *
     * Set for movements that are not real income or spending - a credit card
     * payment reduces the balance owed, so it is neither. Also the general
     * escape hatch for anything the user does not want in their budget.
     */
    excluded: boolean("excluded").notNull().default(false),
    /**
     * Budget bucket this transaction was assigned to.
     *
     * Assignment is separate from Plaid's category on purpose: a merchant rule
     * ("all Starbucks -> Dining") is a budgeting decision, not a claim about
     * what the purchase actually was. Set automatically by the rule engine and
     * overridable per transaction.
     *
     * ON DELETE SET NULL because deleting a bucket should unassign its
     * transactions rather than delete the underlying bank data.
     */
    budgetId: integer("budget_id").references(() => budgets.id, {
      onDelete: "set null",
    }),
    notes: text("notes"),
    pending: boolean("pending").notNull().default(false),
    isoCurrencyCode: varchar("iso_currency_code", { length: 3 }),
    website: text("website"),
    logoUrl: text("logo_url"),
    /** True when we set this row's category from our own recurring detector. */
    isRecurring: boolean("is_recurring").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Idempotency: the same Plaid transaction upserts instead of duplicating.
    uniqueIndex("transactions_plaid_transaction_id_key").on(
      t.plaidTransactionId,
    ),
    index("transactions_account_id_idx").on(t.accountId),
    index("transactions_date_idx").on(t.date),
    index("transactions_category_override_idx").on(t.categoryOverride),
    // Serves the transactions list, which always filters by account + date
    // and is the hottest query in the app.
    index("transactions_account_date_idx").on(t.accountId, t.date),
    // The engine sweeps unassigned, unexcluded rows.
    index("transactions_excluded_idx").on(t.excluded),
  ],
);

// ---------------------------------------------------------------------------
// budget_rules
// ---------------------------------------------------------------------------

/**
 * What a rule matches on.
 *
 * `merchant` beats `category` in evaluation order: a specific merchant rule is a
 * deliberate override of the broad category default. `amount` is the most
 * specific of all and is evaluated first: an exact figure is an unambiguous
 * statement about one transaction, which is how a single irregular payment gets
 * caught without inventing a category for it.
 *
 * Amount rules match on the magnitude, so they catch a $600 outflow and a $600
 * inflow alike. A rule aimed at a loan additionally requires money out, because
 * a loan payment is money out.
 */
export const budgetRuleMatchType = pgEnum("budget_rule_match_type", [
  "merchant",
  "category",
  "amount",
]);

/**
 * Automatic routing of transactions into budget buckets, Rocket Money style.
 *
 * A budget row's `category` is already an implicit category rule, so these rows
 * exist for the cases that category alone can't express: "everything from
 * Starbucks is Dining", "Shell is Transportation".
 *
 * ONE ROW IS ONE STEP, NOT ONE RULE. A rule is every row sharing a
 * `(match_type, match_value)`, which is how "amount 453.91 pays the car loan AND
 * lands in Car Payment" is stored: two rows, one match, two independent targets.
 * Each row still satisfies the one-target CHECK, so the targets stay unambiguous
 * per step while the rule as a whole can have several.
 *
 * The consequence worth knowing: the rule's identity is its match, not its id.
 * Saving a rule replaces every step under that match, and the id a client sends
 * back is only used to find the match.
 */
export const budgetRules = pgTable(
  "budget_rules",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /**
     * Bucket this step routes into.
     *
     * Nullable so a step can point at a loan instead - see `loan_id`. Exactly one
     * of the two is set per row, enforced by a CHECK constraint in the
     * migration, because "goes to a bucket" and "pays off a loan" are different
     * intents and a row claiming both would be ambiguous.
     */
    budgetId: integer("budget_id").references(() => budgets.id, {
      onDelete: "cascade",
    }),
    /**
     * Loan this step pays down. Tagged transactions become loan payments, which
     * is what moves the loan's balance.
     */
    loanId: integer("loan_id").references(() => loans.id, {
      onDelete: "cascade",
    }),
    /**
     * Step says "ignore these" rather than "route these somewhere".
     *
     * A third target alongside bucket and loan, because excluding is a real
     * outcome rather than a bucket of its own. Enforced by the one-target CHECK
     * with exactly one of budget_id, loan_id or exclude set.
     */
    exclude: boolean("exclude").notNull().default(false),
    matchType: budgetRuleMatchType("match_type").notNull(),
    /**
     * For `merchant`: a case-insensitive substring. For `category`: a Plaid
     * category, matched with prefix semantics. For `amount`: the figure as a
     * decimal string, compared numerically against abs(amount) rather than as
     * text, so "600" and "600.00" are the same rule.
     *
     * One value per row, not one per rule: `rule_group` below is what ties the
     * rows together, which is what lets a rule say "UAS *or* US Department of
     * Education" while every row still matches exactly one thing and does exactly
     * one thing.
     */
    matchValue: text("match_value").notNull(),
    /**
     * Rows sharing this are one rule, however many match values it has.
     *
     * A rule used to be identified by (match_type, match_value), which cannot
     * express alternatives: two values with the same steps were two unrelated
     * rules, so "UAS or US Department of Education goes to Student Loans" meant
     * writing the step out twice and editing it twice. Identity has to be
     * something the user does not type, so it is generated here instead.
     *
     * Nullable, and rows without it group by (match_type, match_value) as they
     * always did - so a row from before the column existed still reads as the
     * rule it was, rather than as its own one-row rule.
     */
    ruleGroup: uuid("rule_group"),
    /** Lower runs first. Ties are broken by id so evaluation is deterministic. */
    priority: integer("priority").notNull().default(0),
    /**
     * Position of this step among its siblings, 0-based.
     *
     * The steps of one rule are independent - a loan payment and a bucket
     * assignment do not contend - so this decides nothing except the order they
     * are listed and applied in. It is stored rather than derived from `id`
     * because the user reorders them deliberately, and an id order would quietly
     * undo that on the next refresh.
     */
    stepOrder: integer("step_order").notNull().default(0),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    /*
     * One step per (match, target), rather than one rule per match.
     *
     * This was `UNIQUE (user_id, match_type, match_value)`, which is exactly what
     * made a second step impossible: re-saving the same match with a different
     * target hit the conflict clause and *replaced* the first step instead of
     * adding to it.
     *
     * The two id columns are wrapped in coalesce because btree treats NULLs as
     * distinct, so a plain composite index would happily accept the same ignore
     * step twice. -1 is not a valid id (they are identity columns from 1).
     */
    uniqueIndex("budget_rules_user_match_target_key").on(
      t.userId,
      t.matchType,
      t.matchValue,
      sql`coalesce(${t.budgetId}, -1)`,
      sql`coalesce(${t.loanId}, -1)`,
      t.exclude,
    ),
    index("budget_rules_user_match_idx").on(
      t.userId,
      t.matchType,
      t.matchValue,
    ),
    // How a rule's rows are fetched now that it can have several match values:
    // every read of "all the rows of this rule" goes through the group.
    index("budget_rules_user_group_idx").on(t.userId, t.ruleGroup),
    index("budget_rules_user_budget_idx").on(t.userId, t.budgetId),
    index("budget_rules_user_loan_idx").on(t.userId, t.loanId),
    index("budget_rules_user_priority_idx").on(t.userId, t.priority),
  ],
);

// ---------------------------------------------------------------------------
// recurring (subscriptions)
// ---------------------------------------------------------------------------

export const recurring = pgTable(
  "recurring",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Plaid's stable id when Recurring Transactions is available. */
    plaidRecurringId: text("plaid_recurring_id"),
    merchantName: text("merchant_name").notNull(),
    /** Plaid describes recurring flows as negative (money leaving). */
    avgAmount: numeric("avg_amount", { precision: 14, scale: 2 }),
    frequency: recurringFrequency("frequency").notNull().default("irregular"),
    lastDate: date("last_date"),
    nextExpectedDate: date("next_expected_date"),
    active: boolean("active").notNull().default(true),
    /** "plaid" | "detected" - which source produced this row. */
    source: text("source").notNull().default("detected"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("recurring_plaid_recurring_id_key").on(t.plaidRecurringId),
    index("recurring_user_active_idx").on(t.userId, t.active),
  ],
);

// ---------------------------------------------------------------------------
// securities + holdings (investments)
// ---------------------------------------------------------------------------

export const securities = pgTable(
  "securities",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    plaidSecurityId: text("plaid_security_id").notNull(),
    name: text("name").notNull(),
    tickerSymbol: text("ticker_symbol"),
    isin: text("isin"),
    cusip: text("cusip"),
    type: text("type"),
    /** Prices are as-of the last Plaid update, not live quotes. */
    closePrice: numeric("close_price", { precision: 18, scale: 6 }),
    closePriceAsOf: date("close_price_as_of"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("securities_plaid_security_id_key").on(t.plaidSecurityId)],
);

export const holdings = pgTable(
  "holdings",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    securityId: integer("security_id")
      .notNull()
      .references(() => securities.id, { onDelete: "cascade" }),
    quantity: numeric("quantity", { precision: 24, scale: 8 })
      .notNull()
      .default("0"),
    /** Price the institution reported (i.e. today's value, not cost basis). */
    institutionPrice: numeric("institution_price", { precision: 18, scale: 6 }),
    institutionValue: numeric("institution_value", {
      precision: 18,
      scale: 4,
    }),
    costBasis: numeric("cost_basis", { precision: 18, scale: 4 }),
    isoCurrencyCode: varchar("iso_currency_code", { length: 3 }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Re-syncing holdings must replace, not duplicate, the same position.
    uniqueIndex("holdings_account_security_key").on(t.accountId, t.securityId),
    index("holdings_account_id_idx").on(t.accountId),
  ],
);

export const investmentTxns = pgTable(
  "investment_transactions",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    securityId: integer("security_id").references(() => securities.id, {
      onDelete: "set null",
    }),
    plaidInvestmentTxnId: text("plaid_investment_txn_id").notNull(),
    name: text("name"),
    date: date("date").notNull(),
    type: investmentTxnType("type").notNull(),
    subtype: text("subtype"),
    quantity: numeric("quantity", { precision: 24, scale: 8 }),
    price: numeric("price", { precision: 18, scale: 6 }),
    amount: numeric("amount", { precision: 18, scale: 4 }),
    fees: numeric("fees", { precision: 14, scale: 4 }),
    isoCurrencyCode: varchar("iso_currency_code", { length: 3 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("investment_txns_plaid_id_key").on(t.plaidInvestmentTxnId),
    index("investment_txns_account_date_idx").on(t.accountId, t.date),
  ],
);

// ---------------------------------------------------------------------------
// liabilities
// ---------------------------------------------------------------------------

export const liabilities = pgTable(
  "liabilities",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    kind: liabilityKind("kind").notNull().default("other"),
    /** Annual percentage rate, as a percent (e.g. 18.99 for 18.99%). */
    apr: numeric("apr", { precision: 8, scale: 4 }),
    minimumPayment: numeric("minimum_payment", { precision: 14, scale: 2 }),
    nextDueDate: date("next_due_date"),
    lastStatementBalance: numeric("last_statement_balance", {
      precision: 18,
      scale: 4,
    }),
    lastStatementDate: date("last_statement_date"),
    /** Full /liabilities/get payload, kept so we can add fields without a re-sync. */
    rawJson: jsonb("raw_json").$type<Record<string, unknown>>(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("liabilities_account_id_key").on(t.accountId),
    index("liabilities_kind_idx").on(t.kind),
  ],
);

// ---------------------------------------------------------------------------
// manual_accounts (things Plaid can't see)
// ---------------------------------------------------------------------------

export const manualAccounts = pgTable(
  "manual_accounts",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: manualAccountKind("kind").notNull(),
    /** Always positive; `kind` decides the net-worth sign. */
    value: numeric("value", { precision: 18, scale: 4 }).notNull(),
    /** e.g. "home", "car", "crypto" - purely informational. */
    category: text("category"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("manual_accounts_user_id_idx").on(t.userId)],
);

// ---------------------------------------------------------------------------
// loans + loan_payments (debt the user tracks by hand)
// ---------------------------------------------------------------------------

/**
 * A loan the user tracks manually, because Plaid does not see it.
 *
 * Deliberately separate from `liabilities`, which is pinned 1:1 to a synced
 * account (`uniqueIndex(account_id)`) and whose balance belongs to Plaid. A car
 * loan held at a credit union the user does not bank with is invisible to Plaid,
 * so the balance has to be ours.
 *
 * Interest model: simple interest on the outstanding balance, accrued per day at
 * APR/365 from `last_accrued_at`. Actual/365 rather than a whole monthly step
 * because payments get tagged whenever the user gets round to it, not on a
 * billing date.
 */
export const loans = pgTable(
  "loans",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: loanKind("kind").notNull().default("other"),
    /** APR as a percent, e.g. 5.9 for 5.9% - same convention as liabilities.apr. */
    apr: numeric("apr", { precision: 8, scale: 4 }).notNull().default("0"),
    /** Original amount borrowed. Kept so payoff progress can be shown. */
    principal: numeric("principal", { precision: 18, scale: 2 })
      .notNull()
      .default("0"),
    /**
     * What is still owed.
     *
     * Authoritative and user-editable (a lender correction or a missed payment
     * is a real thing), but also moved by the `loan_payments` trigger: each
     * payment adds the interest it accrued and subtracts the principal it
     * retired. The trigger is what keeps this honest when Plaid later deletes
     * the underlying transaction during a sync.
     */
    balance: numeric("balance", { precision: 18, scale: 2 })
      .notNull()
      .default("0"),
    /** Expected payment. Informational: drives the payoff projection only. */
    paymentAmount: numeric("payment_amount", { precision: 18, scale: 2 }),
    /**
     * Interest has been accounted for up to this date. Advanced by each
     * accrual, so tagging two payments a month apart does not double-count.
     * Null means "not yet accrued"; the loan treats that as its created date.
     */
    lastAccruedAt: date("last_accrued_at"),
    /** Date the loan started, used for the initial accrual period. */
    openedOn: date("opened_on").notNull(),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("loans_user_name_key").on(t.userId, t.name),
    index("loans_user_id_idx").on(t.userId),
  ],
);

/**
 * A tagged transaction paying down a loan.
 *
 * This ledger, not a column on `transactions`, is the record of a loan payment.
 * Two reasons it earns its own table:
 *
 *  1. It stores the interest/principal split. Recomputing that later would give a
 *     different answer, because it depends on the balance at the moment of
 *     payment and the balance is user-editable.
 *  2. UNIQUE on transaction_id means a transaction can pay at most one loan, and
 *     ON DELETE CASCADE means that when Plaid reports the transaction removed
 *     (sync.ts deletes the row), the payment disappears too and the trigger
 *     returns the money to the balance.
 */
export const loanPayments = pgTable(
  "loan_payments",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    loanId: integer("loan_id")
      .notNull()
      .references(() => loans.id, { onDelete: "cascade" }),
    transactionId: integer("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    /** Gross amount that left the bank account. Always equals interest + principal. */
    amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
    /** Portion of `amount` that was interest: it increased the balance. */
    interest: numeric("interest", { precision: 18, scale: 2 })
      .notNull()
      .default("0"),
    /** Portion of `amount` that actually reduced the balance. */
    principal: numeric("principal", { precision: 18, scale: 2 })
      .notNull()
      .default("0"),
    /** Overpayment on a loan that was already settled. Kept for the audit trail. */
    overpayment: numeric("overpayment", { precision: 18, scale: 2 })
      .notNull()
      .default("0"),
    /** Transaction date, not insertion date, so history reads chronologically. */
    paidOn: date("paid_on").notNull(),
    /**
     * Whether this payment was tagged by the user or minted by a rule, so
     * removing a rule step can undo only its own writes.
     *
     * No default on purpose. Every insert has to say which it is; a default
     * that guesses wrong makes an undo skip the rows it was supposed to remove,
     * which is indistinguishable from the undo not working at all.
     */
    source: loanPaymentSource("source").notNull(),
    /**
     * Start of the interest period this payment closed: the loan's
     * `last_accrued_at` before the payment (or `opened_on` if it had never
     * accrued).
     *
     * Recorded so the trigger can put `last_accrued_at` back on delete. Without
     * it, un-tagging a payment would restore the balance but leave the accrual
     * cursor advanced, so the reverted stretch of interest would never be
     * counted again.
     */
    accruedFrom: date("accrued_from").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("loan_payments_transaction_id_key").on(t.transactionId),
    index("loan_payments_loan_id_idx").on(t.loanId),
    index("loan_payments_loan_paid_on_idx").on(t.loanId, t.paidOn),
  ],
);

/**
 * A linked account's balance on one day, written by the daily cron.
 *
 * Loan balances deliberately do NOT need a table like this one, because the
 * `loan_payments` ledger can reconstruct them exactly - see `loanBalanceSeries`
 * in `src/lib/loan-math.ts`. Accounts have no equivalent: Plaid reports current
 * balances only, transactions do not determine a balance (transfers, interest and
 * pending authorisations all move one without the other), so the only honest
 * record of an account's balance on a past day is one we wrote that day.
 *
 * Which also means there is nothing to backfill, and this table starts empty.
 */
export const accountBalanceSnapshots = pgTable(
  "account_balance_snapshots",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /** Date column (not timestamptz), so the unique index is a real day guard. */
    snapshotDate: date("snapshot_date").notNull(),
    /** `accounts.current_balance` as the cron read it that day. */
    balance: numeric("balance", { precision: 18, scale: 4 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // One reading per account per day, and the re-run path updates rather than
    // duplicating. Doubles as the index that serves the chart's
    // `where account_id = ? order by snapshot_date` query, so no second index.
    uniqueIndex("account_balance_snapshots_account_date_key").on(
      t.accountId,
      t.snapshotDate,
    ),
  ],
);

export type AccountBalanceSnapshot = typeof accountBalanceSnapshots.$inferSelect;

// ---------------------------------------------------------------------------
// net_worth_snapshots (one row per user per day, written by the cron job)
// ---------------------------------------------------------------------------

export const netWorthSnapshots = pgTable(
  "net_worth_snapshots",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Date column (not timestamptz) so the unique index is a real day guard. */
    snapshotDate: date("snapshot_date").notNull(),
    assetsTotal: numeric("assets_total", { precision: 18, scale: 4 })
      .notNull()
      .default("0"),
    liabilitiesTotal: numeric("liabilities_total", {
      precision: 18,
      scale: 4,
    })
      .notNull()
      .default("0"),
    netWorth: numeric("net_worth", { precision: 18, scale: 4 })
      .notNull()
      .default("0"),
    /** Per-account-type breakdown so we can chart composition over time. */
    breakdownJson: jsonb("breakdown_json").$type<NetWorthBreakdown>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Makes the daily snapshot job idempotent: re-running it updates the row.
    uniqueIndex("net_worth_snapshots_user_date_key").on(
      t.userId,
      t.snapshotDate,
    ),
    index("net_worth_snapshots_user_date_idx").on(t.userId, t.snapshotDate),
  ],
);

/**
 * Per-account-type composition stored on each snapshot, so the history chart
 * can show how net worth is made up and not only the total.
 */
export type NetWorthBreakdown = {
  cash: number;
  other: number;
  investments: number;
  creditCards: number;
  loans: number;
  manualAssets: number;
  manualLiabilities: number;
  accountCount: number;
  liabilityCount: number;
};

/** Enum values we can iterate when normalising Plaid's raw strings. */
export const ACCOUNT_TYPES = [
  "depository",
  "credit",
  "loan",
  "investment",
  "other",
] as const satisfies readonly (typeof accountType.enumValues)[number][];

export const ACCOUNT_SUBTYPES = [
  "checking",
  "savings",
  "money market",
  "certificate of deposit",
  "credit card",
  "student",
  "mortgage",
  "personal",
  "auto",
  "home equity",
  "brokerage",
  "401k",
  "ira",
  "roth ira",
  "other",
] as const satisfies readonly (typeof accountSubtype.enumValues)[number][];

/** Plaid account types/subtypes we don't model yet fall back to these. */
export const FALLBACK_ACCOUNT_TYPE = "other" as const;
export const FALLBACK_ACCOUNT_SUBTYPE = "other" as const;

export type AccountType = (typeof accountType.enumValues)[number];
export type AccountSubtype = (typeof accountSubtype.enumValues)[number];
export type ItemStatus = (typeof itemStatus.enumValues)[number];
export type RecurringFrequency = (typeof recurringFrequency.enumValues)[number];
export type ManualAccountKind = (typeof manualAccountKind.enumValues)[number];
export type BudgetKind = (typeof budgetKind.enumValues)[number];
export type BudgetRuleMatchType = (typeof budgetRuleMatchType.enumValues)[number];
export type LiabilityKind = (typeof liabilityKind.enumValues)[number];
export type LoanKind = (typeof loanKind.enumValues)[number];
export type LoanPaymentSource = (typeof loanPaymentSource.enumValues)[number];

export type User = typeof users.$inferSelect;
export type Item = typeof items.$inferSelect;
// ---------------------------------------------------------------------------
// budget_worksheet
// ---------------------------------------------------------------------------

/**
 * One saved budget worksheet per user, ported from the "After Raise" sheet of a
 * spreadsheet.
 *
 * Deliberately a fixed set of columns rather than a key/value table: this is one
 * specific form, and the whole value of it is that every field has a known name, a
 * known place on the page and a known place in the arithmetic. A generic
 * key/value store would make the form rebuild itself from whatever rows happened
 * to be saved.
 *
 * Separate from `budgets` on purpose. `budgets` measures what actually happened to
 * real transactions; this is what the user *intends*, and nothing reconciles the
 * two. Keeping them apart is what stops one from quietly overwriting the other.
 *
 * Every amount is stored as a positive magnitude. The spreadsheet holds its
 * deductions as negative numbers and subtracts them, which means a total is a sum
 * of mixed signs and a typo there inverts the whole sheet. Positives plus explicit
 * subtraction cannot do that, and the form can display a deduction as a deduction
 * without carrying the sign twice.
 */
export const budgetWorksheet = pgTable(
  "budget_worksheet",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /**
     * Solve gross pay backwards from the bills instead of taking it as given.
     *
     * Opt-in, and false by default, because on the sheet this came from it cannot
     * reproduce the figures in it. Solving off the bills gives a salary far below
     * the deductions taken out of it - $238 a month against $2,611 withheld - so
     * take-home comes out thousands negative. The same worksheet with the salary
     * typed produces a take-home within a few dollars of what the bank actually
     * recorded, which is the tie that says which half is the real one.
     *
     * Kept because it is the right tool for the job the sheet was originally built
     * for: deciding what gross a target set of bills requires.
     */
    deriveGross: boolean("derive_gross").notNull().default(false),

    /** Annual gross, before any deductions. Used when `deriveGross` is false. */
    grossSalary: numeric("gross_salary", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
    /**
     * Share of total compensation taken as stock, which is why gross has to be
     * grossed up. The sheet solves `gross = bills + 12% of gross`, i.e. it is
     * already inside the gross figure.
     */
    asopRate: numeric("asop_rate", { precision: 6, scale: 4 })
      .notNull()
      .default("0.12"),

    // --- Withholdings, per semi-monthly pay period, doubled in the maths -----
    federalWithholding: numeric("federal_withholding", { precision: 12, scale: 2 })
      .notNull()
      .default("0"),
    federalMedEe: numeric("federal_med_ee", { precision: 12, scale: 2 })
      .notNull()
      .default("0"),
    federalOasdiEe: numeric("federal_oasdi_ee", { precision: 12, scale: 2 })
      .notNull()
      .default("0"),
    stateWithholding: numeric("state_withholding", { precision: 12, scale: 2 })
      .notNull()
      .default("0"),

    // --- Pre-tax deductions, per semi-monthly pay period --------------------
    k401k: numeric("k401k", { precision: 12, scale: 2 }).notNull().default("0"),
    vision: numeric("vision", { precision: 12, scale: 2 }).notNull().default("0"),
    dental: numeric("dental", { precision: 12, scale: 2 }).notNull().default("0"),
    hsa: numeric("hsa", { precision: 12, scale: 2 }).notNull().default("0"),
    medical: numeric("medical", { precision: 12, scale: 2 }).notNull().default("0"),

    /** After-tax, per pay period. */
    rothIra: numeric("roth_ira", { precision: 12, scale: 2 }).notNull().default("0"),

    /**
     * Pay periods in an average month, i.e. how many times a per-period figure
     * repeats to make a monthly one.
     *
     * Default 26/12 rather than a flat 2, because biweekly pay is the norm in the
     * US and a flat 2 models only 24 periods a year - two short. On real figures
     * that understates a year's withholding by about 7.7% and overstates monthly
     * take-home by the same, which is enough to make a plan look affordable that is
     * not. Checked against what this app has actually recorded: 26/12 lands within
     * $24 a month, a flat 2 is off by $241.
     *
     * Set this to 2 for genuine semi-monthly pay (the 1st and 15th, 24 a year),
     * which is what the spreadsheet this came from assumed.
     *
     * Stored at four decimal places, so 26/12 comes back as 2.1667. The 0.00003
     * error is worth roughly four cents a month of take-home - kept deliberately
     * rather than chased, since no decimal column holds that ratio exactly and
     * the alternative is storing a pay frequency as an enum and deriving the
     * count, which is worse for a field the user may legitimately want to tune.
     */
    payPeriodsPerMonth: numeric("pay_periods_per_month", { precision: 6, scale: 4 })
      .notNull()
      .default("2.1667"),

    /**
     * Count the 401k and Roth IRA as savings in the 50/30/20 comparison.
     *
     * Off by default, which matches the spreadsheet: it kept retirement in its own
     * section and counted only the goals as savings. That separation is arguably
     * correct rather than a quirk, because the two are funded from different pots -
     * retirement comes out of gross before you are paid, the goals come out of what
     * reaches your account. Turning it on folds them into one savings figure,
     * which is the more common reading of the rule.
     */
    includeRetirementInSavings: boolean("include_retirement_in_savings")
      .notNull()
      .default(false),

    // --- Needs: monthly ----------------------------------------------------
    rent: numeric("rent", { precision: 12, scale: 2 }).notNull().default("0"),
    utilities: numeric("utilities", { precision: 12, scale: 2 }).notNull().default("0"),
    wifi: numeric("wifi", { precision: 12, scale: 2 }).notNull().default("0"),
    rentersInsurance: numeric("renters_insurance", { precision: 12, scale: 2 })
      .notNull()
      .default("0"),
    carPayment: numeric("car_payment", { precision: 12, scale: 2 }).notNull().default("0"),
    carInsurance: numeric("car_insurance", { precision: 12, scale: 2 }).notNull().default("0"),
    gas: numeric("gas", { precision: 12, scale: 2 }).notNull().default("0"),
    groceriesDining: numeric("groceries_dining", { precision: 12, scale: 2 })
      .notNull()
      .default("0"),

    // --- Financial goals: monthly ------------------------------------------
    studentLoans: numeric("student_loans", { precision: 12, scale: 2 })
      .notNull()
      .default("0"),
    brokerage: numeric("brokerage", { precision: 12, scale: 2 }).notNull().default("0"),
    hysa: numeric("hysa", { precision: 12, scale: 2 }).notNull().default("0"),

    // --- The 50/30/20 targets ------------------------------------------------
    idealNeeds: numeric("ideal_needs", { precision: 6, scale: 4 })
      .notNull()
      .default("0.5"),
    idealSavings: numeric("ideal_savings", { precision: 6, scale: 4 })
      .notNull()
      .default("0.3"),
    idealWants: numeric("ideal_wants", { precision: 6, scale: 4 })
      .notNull()
      .default("0.2"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // One worksheet per user: this is a single standing plan, not a per-month
    // record, so a user row would be ambiguous about which one is current.
    uniqueIndex("budget_worksheet_user_id_key").on(t.userId),
  ],
);

export type BudgetWorksheet = typeof budgetWorksheet.$inferSelect;

export type Account = typeof accounts.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
export type Budget = typeof budgets.$inferSelect;
export type BudgetRule = typeof budgetRules.$inferSelect;
export type RecurringCharge = typeof recurring.$inferSelect;
export type Security = typeof securities.$inferSelect;
export type Holding = typeof holdings.$inferSelect;
export type InvestmentTxn = typeof investmentTxns.$inferSelect;
export type Liability = typeof liabilities.$inferSelect;
export type ManualAccount = typeof manualAccounts.$inferSelect;
export type Loan = typeof loans.$inferSelect;
export type LoanPayment = typeof loanPayments.$inferSelect;
export type NetWorthSnapshot = typeof netWorthSnapshots.$inferSelect;

/** Plaid gives us decimals as strings; everything downstream wants numbers. */
export function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}