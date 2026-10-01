CREATE TYPE "public"."account_subtype" AS ENUM('checking', 'savings', 'money market', 'certificate of deposit', 'credit card', 'student', 'mortgage', 'personal', 'auto', 'home equity', 'brokerage', '401k', 'ira', 'roth ira', 'other');--> statement-breakpoint
CREATE TYPE "public"."account_type" AS ENUM('depository', 'credit', 'loan', 'investment', 'other');--> statement-breakpoint
CREATE TYPE "public"."investment_txn_type" AS ENUM('buy', 'sell', 'dividend', 'interest', 'contribution', 'withdrawal', 'fee', 'other');--> statement-breakpoint
CREATE TYPE "public"."item_status" AS ENUM('healthy', 'login_required', 'requires_update', 'pending_expiration', 'user_locked', 'item_locked', 'revoked', 'error', 'pending_disconnect');--> statement-breakpoint
CREATE TYPE "public"."liability_kind" AS ENUM('credit', 'student', 'mortgage', 'other');--> statement-breakpoint
CREATE TYPE "public"."manual_account_kind" AS ENUM('asset', 'liability');--> statement-breakpoint
CREATE TYPE "public"."plaid_environment" AS ENUM('sandbox', 'production');--> statement-breakpoint
CREATE TYPE "public"."recurring_frequency" AS ENUM('weekly', 'monthly', 'quarterly', 'annually', 'irregular');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "accounts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"item_id" integer NOT NULL,
	"plaid_account_id" text NOT NULL,
	"name" text NOT NULL,
	"official_name" text,
	"mask" text,
	"type" "account_type" NOT NULL,
	"subtype" "account_subtype",
	"current_balance" numeric(18, 4) NOT NULL,
	"available_balance" numeric(18, 4),
	"iso_currency_code" varchar(3) DEFAULT 'USD' NOT NULL,
	"balance_updated_at" timestamp with time zone,
	"plaid_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budgets" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "budgets_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" text NOT NULL,
	"category" text NOT NULL,
	"monthly_limit" numeric(14, 2) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "holdings" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "holdings_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"account_id" integer NOT NULL,
	"security_id" integer NOT NULL,
	"quantity" numeric(24, 8) DEFAULT '0' NOT NULL,
	"institution_price" numeric(18, 6),
	"institution_value" numeric(18, 4),
	"cost_basis" numeric(18, 4),
	"iso_currency_code" varchar(3),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "investment_transactions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "investment_transactions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"account_id" integer NOT NULL,
	"security_id" integer,
	"plaid_investment_txn_id" text NOT NULL,
	"name" text,
	"date" date NOT NULL,
	"type" "investment_txn_type" NOT NULL,
	"subtype" text,
	"quantity" numeric(24, 8),
	"price" numeric(18, 6),
	"amount" numeric(18, 4),
	"fees" numeric(14, 4),
	"iso_currency_code" varchar(3),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "items_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" text NOT NULL,
	"plaid_item_id" text NOT NULL,
	"access_token_encrypted" text NOT NULL,
	"institution_name" text,
	"institution_id" text,
	"cursor" text,
	"status" "item_status" DEFAULT 'healthy' NOT NULL,
	"error_code" text,
	"error_message" text,
	"environment" "plaid_environment" DEFAULT 'sandbox' NOT NULL,
	"consented_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "liabilities" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "liabilities_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"account_id" integer NOT NULL,
	"kind" "liability_kind" DEFAULT 'other' NOT NULL,
	"apr" numeric(8, 4),
	"minimum_payment" numeric(14, 2),
	"next_due_date" date,
	"last_statement_balance" numeric(18, 4),
	"last_statement_date" date,
	"raw_json" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "manual_accounts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "manual_accounts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" "manual_account_kind" NOT NULL,
	"value" numeric(18, 4) NOT NULL,
	"category" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "net_worth_snapshots" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "net_worth_snapshots_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" text NOT NULL,
	"snapshot_date" date NOT NULL,
	"assets_total" numeric(18, 4) DEFAULT '0' NOT NULL,
	"liabilities_total" numeric(18, 4) DEFAULT '0' NOT NULL,
	"net_worth" numeric(18, 4) DEFAULT '0' NOT NULL,
	"breakdown_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recurring" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "recurring_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" text NOT NULL,
	"plaid_recurring_id" text,
	"merchant_name" text NOT NULL,
	"avg_amount" numeric(14, 2),
	"frequency" "recurring_frequency" DEFAULT 'irregular' NOT NULL,
	"last_date" date,
	"next_expected_date" date,
	"active" boolean DEFAULT true NOT NULL,
	"source" text DEFAULT 'detected' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "securities" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "securities_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"plaid_security_id" text NOT NULL,
	"name" text NOT NULL,
	"ticker_symbol" text,
	"isin" text,
	"cusip" text,
	"type" text,
	"close_price" numeric(18, 6),
	"close_price_as_of" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "transactions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"account_id" integer NOT NULL,
	"plaid_transaction_id" text NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"date" date NOT NULL,
	"authorized_date" date,
	"merchant_name" text,
	"name" text,
	"plaid_category_primary" text,
	"plaid_category_detailed" text,
	"category_override" text,
	"notes" text,
	"pending" boolean DEFAULT false NOT NULL,
	"iso_currency_code" varchar(3),
	"website" text,
	"logo_url" text,
	"is_recurring" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holdings" ADD CONSTRAINT "holdings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holdings" ADD CONSTRAINT "holdings_security_id_securities_id_fk" FOREIGN KEY ("security_id") REFERENCES "public"."securities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_transactions" ADD CONSTRAINT "investment_transactions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_transactions" ADD CONSTRAINT "investment_transactions_security_id_securities_id_fk" FOREIGN KEY ("security_id") REFERENCES "public"."securities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "liabilities" ADD CONSTRAINT "liabilities_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_accounts" ADD CONSTRAINT "manual_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "net_worth_snapshots" ADD CONSTRAINT "net_worth_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring" ADD CONSTRAINT "recurring_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_plaid_account_id_key" ON "accounts" USING btree ("plaid_account_id");--> statement-breakpoint
CREATE INDEX "accounts_item_id_idx" ON "accounts" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "accounts_type_idx" ON "accounts" USING btree ("type");--> statement-breakpoint
CREATE UNIQUE INDEX "budgets_user_category_key" ON "budgets" USING btree ("user_id","category");--> statement-breakpoint
CREATE UNIQUE INDEX "holdings_account_security_key" ON "holdings" USING btree ("account_id","security_id");--> statement-breakpoint
CREATE INDEX "holdings_account_id_idx" ON "holdings" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "investment_txns_plaid_id_key" ON "investment_transactions" USING btree ("plaid_investment_txn_id");--> statement-breakpoint
CREATE INDEX "investment_txns_account_date_idx" ON "investment_transactions" USING btree ("account_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "items_plaid_item_id_key" ON "items" USING btree ("plaid_item_id");--> statement-breakpoint
CREATE INDEX "items_user_id_idx" ON "items" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "items_status_idx" ON "items" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "liabilities_account_id_key" ON "liabilities" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "liabilities_kind_idx" ON "liabilities" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "manual_accounts_user_id_idx" ON "manual_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "net_worth_snapshots_user_date_key" ON "net_worth_snapshots" USING btree ("user_id","snapshot_date");--> statement-breakpoint
CREATE INDEX "net_worth_snapshots_user_date_idx" ON "net_worth_snapshots" USING btree ("user_id","snapshot_date");--> statement-breakpoint
CREATE UNIQUE INDEX "recurring_plaid_recurring_id_key" ON "recurring" USING btree ("plaid_recurring_id");--> statement-breakpoint
CREATE INDEX "recurring_user_active_idx" ON "recurring" USING btree ("user_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "securities_plaid_security_id_key" ON "securities" USING btree ("plaid_security_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_plaid_transaction_id_key" ON "transactions" USING btree ("plaid_transaction_id");--> statement-breakpoint
CREATE INDEX "transactions_account_id_idx" ON "transactions" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "transactions_date_idx" ON "transactions" USING btree ("date");--> statement-breakpoint
CREATE INDEX "transactions_category_override_idx" ON "transactions" USING btree ("category_override");--> statement-breakpoint
CREATE INDEX "transactions_account_date_idx" ON "transactions" USING btree ("account_id","date");