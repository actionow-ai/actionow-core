CREATE TABLE "account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"credit_balance" bigint DEFAULT 0 NOT NULL,
	"credit_held" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_balance_ge_held" CHECK ("account"."credit_balance" >= "account"."credit_held")
);
--> statement-breakpoint
CREATE TABLE "dify_binding" (
	"resource_id" text NOT NULL,
	"resource_version" integer NOT NULL,
	"mode" text NOT NULL,
	"dify_app_endpoint" text NOT NULL,
	"dify_service_key_ref" uuid,
	"dsl_hash" text NOT NULL,
	"pricing_model" text NOT NULL,
	"provision_mode" text DEFAULT 'byo' NOT NULL,
	"required_secrets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"compat_report" jsonb
);
--> statement-breakpoint
CREATE TABLE "resource" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"modality" text NOT NULL,
	"provider_type" text NOT NULL,
	"exec_modes" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resource_version" (
	"resource_id" text NOT NULL,
	"version" integer NOT NULL,
	"io_schema" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "secret_ref" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"locator" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upstream_channel" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resource_id" text NOT NULL,
	"provider_type" text NOT NULL,
	"credential_ref" uuid,
	"weight" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_key" (
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"job_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"resource_id" text NOT NULL,
	"resource_version" bigint NOT NULL,
	"status" text NOT NULL,
	"exec_mode" text NOT NULL,
	"inputs" jsonb NOT NULL,
	"output" jsonb,
	"usage" jsonb,
	"upstream_job_handle" text,
	"pricebook_entry_id" uuid,
	"pricebook_version" bigint,
	"modifiers_snapshot" jsonb,
	"quoted_credits" bigint,
	"cost_credits" bigint,
	"hold_id" uuid,
	"hold_expires_at" timestamp with time zone,
	"callback_url" text,
	"idempotency_key" text,
	"end_user" text,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_txn" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"type" text NOT NULL,
	"credits_delta" bigint NOT NULL,
	"balance_after" bigint NOT NULL,
	"resource_id" text,
	"job_id" uuid,
	"pricebook_version" bigint,
	"modifiers_applied" jsonb,
	"usage_vector" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"url" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text DEFAULT 'admin' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "api_key" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"hash" text NOT NULL,
	"resource_allowlist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rate_limit" bigint,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"isolation_mode" text DEFAULT 'field' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gift_code" (
	"code" text PRIMARY KEY NOT NULL,
	"tenant_scope" uuid,
	"credits" bigint NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "modifier" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"when_expr" text,
	"op" text NOT NULL,
	"value" bigint,
	"stackable" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pricebook_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resource_id" text NOT NULL,
	"resource_version" integer NOT NULL,
	"version" integer NOT NULL,
	"method" text NOT NULL,
	"timing" text NOT NULL,
	"spec" jsonb NOT NULL,
	"markup" jsonb,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dify_binding" ADD CONSTRAINT "dify_binding_resource_id_resource_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resource"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource" ADD CONSTRAINT "resource_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_version" ADD CONSTRAINT "resource_version_resource_id_resource_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resource"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upstream_channel" ADD CONSTRAINT "upstream_channel_resource_id_resource_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resource"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_key" ADD CONSTRAINT "idempotency_key_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_resource_id_resource_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resource"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_txn" ADD CONSTRAINT "ledger_txn_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_txn" ADD CONSTRAINT "ledger_txn_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricebook_entry" ADD CONSTRAINT "pricebook_entry_resource_id_resource_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resource"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "resource_version_pk" ON "resource_version" USING btree ("resource_id","version");--> statement-breakpoint
CREATE INDEX "upstream_resource_idx" ON "upstream_channel" USING btree ("resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_tenant_key" ON "idempotency_key" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE INDEX "job_status_idx" ON "job" USING btree ("status");--> statement-breakpoint
CREATE INDEX "job_tenant_idx" ON "job" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_settle_per_job" ON "ledger_txn" USING btree ("job_id") WHERE type = 'settle';--> statement-breakpoint
CREATE INDEX "ledger_job_idx" ON "ledger_txn" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "outbox_due_idx" ON "webhook_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "api_key_hash_idx" ON "api_key" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "api_key_tenant_idx" ON "api_key" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "pricebook_resource_idx" ON "pricebook_entry" USING btree ("resource_id","version");