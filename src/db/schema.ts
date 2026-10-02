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
     * Plaid primary category this row's "actual" is measured against, e.g.
     * "FOOD_AND_DRINK". Null means the row is display-only (a fixed bill like
     * rent, which has no Plaid category), so its actual stays 0 until a
     * category is chosen.
     *
     * Separate from `name` so the user can call a row "Weekend" while still
     * measuring it against DINING_AND_DRINK.
     */
    category: text("category"),
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
 */
export const budgetRules = pgTable(
  "budget_rules",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /**
     * Bucket this rule routes into.
     *
     * Nullable so a rule can point at a loan instead - see `loan_id`. Exactly one
     * of the two is set, enforced by a CHECK constraint in the migration, because
     * "goes to a bucket" and "pays off a loan" are different intents and a row
     * claiming both would be ambiguous.
     */
    budgetId: integer("budget_id").references(() => budgets.id, {
      onDelete: "cascade",
    }),
    /**
     * Loan this rule pays down. Tagged transactions become loan payments, which
     * is what moves the loan's balance.
     */
    loanId: integer("loan_id").references(() => loans.id, {
      onDelete: "cascade",
    }),
    /**
     * Rule says "ignore these" rather than "route these somewhere".
     *
     * A third target alongside bucket and loan, because excluding is a real
     * outcome rather than a bucket of its own. Enforced by the one-target CHECK
     * with exactly one of budget_id, loan_id or exclude set.
     */
    exclude: boolean("exclude").notNull().default(false),
    matchType: budgetRuleMatchType("match_type").notNull(),
    /**
     * For `merchant`: a case-insensitive substring of the merchant or raw
     * description. For `category`: a Plaid category value, matched with prefix
     * semantics so `FOOD_AND_DRINK` absorbs its detailed children.
     */
    /**
     * For `merchant`: a case-insensitive substring. For `category`: a Plaid
     * category, matched with prefix semantics. For `amount`: the figure as a
     * decimal string, compared numerically against abs(amount) rather than as
     * text, so "600" and "600.00" are the same rule.
     */
    matchValue: text("match_value").notNull(),
    /** Lower runs first. Ties are broken by id so evaluation is deterministic. */
    priority: integer("priority").notNull().default(0),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // One rule per (type, value): re-saving a rule updates it instead of
    // silently stacking duplicates.
    uniqueIndex("budget_rules_user_type_value_key").on(
      t.userId,
      t.matchType,
      t.matchValue,
    ),
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

export type User = typeof users.$inferSelect;
export type Item = typeof items.$inferSelect;
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