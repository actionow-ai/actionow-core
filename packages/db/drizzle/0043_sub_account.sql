CREATE TABLE "sub_account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"credit_balance" bigint DEFAULT 0 NOT NULL,
	"credit_held" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "sub_account_balance_ge_held" CHECK ("sub_account"."credit_balance" >= "sub_account"."credit_held"),
	CONSTRAINT "sub_account_balance_ge0" CHECK ("sub_account"."credit_balance" >= 0),
	CONSTRAINT "sub_account_held_ge0" CHECK ("sub_account"."credit_held" >= 0),
	CONSTRAINT "sub_account_status_allowed" CHECK ("sub_account"."status" IN ('active', 'disabled'))
);
--> statement-breakpoint
ALTER TABLE "sub_account" ADD CONSTRAINT "sub_account_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sub_account" ADD CONSTRAINT "sub_account_subject_id_subject_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subject"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sub_account_tenant_subject_unique" ON "sub_account" USING btree ("tenant_id","subject_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "sub_account_subject_idx" ON "sub_account" USING btree ("subject_id");