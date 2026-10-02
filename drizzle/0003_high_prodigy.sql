CREATE TYPE "public"."loan_kind" AS ENUM('auto', 'personal', 'student', 'mortgage', 'medical', 'other');--> statement-breakpoint
CREATE TABLE "loan_payments" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "loan_payments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"loan_id" integer NOT NULL,
	"transaction_id" integer NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"interest" numeric(18, 2) DEFAULT '0' NOT NULL,
	"principal" numeric(18, 2) DEFAULT '0' NOT NULL,
	"overpayment" numeric(18, 2) DEFAULT '0' NOT NULL,
	"paid_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loans" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "loans_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" "loan_kind" DEFAULT 'other' NOT NULL,
	"apr" numeric(8, 4) DEFAULT '0' NOT NULL,
	"principal" numeric(18, 2) DEFAULT '0' NOT NULL,
	"balance" numeric(18, 2) DEFAULT '0' NOT NULL,
	"payment_amount" numeric(18, 2),
	"last_accrued_at" date,
	"opened_on" date NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "loan_payments" ADD CONSTRAINT "loan_payments_loan_id_loans_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_payments" ADD CONSTRAINT "loan_payments_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "loan_payments_transaction_id_key" ON "loan_payments" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "loan_payments_loan_id_idx" ON "loan_payments" USING btree ("loan_id");--> statement-breakpoint
CREATE INDEX "loan_payments_loan_paid_on_idx" ON "loan_payments" USING btree ("loan_id","paid_on");--> statement-breakpoint
CREATE UNIQUE INDEX "loans_user_name_key" ON "loans" USING btree ("user_id","name");--> statement-breakpoint
CREATE INDEX "loans_user_id_idx" ON "loans" USING btree ("user_id");