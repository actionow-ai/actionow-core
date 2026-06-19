ALTER TABLE "account" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channel_health" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "dify_binding" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "dify_binding" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "resource" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "resource" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "secret_ref" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "secret_ref" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "upstream_channel" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "upstream_channel" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "api_key" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "api_key" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenant" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "model" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oauth_session" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_session" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gift_code" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "modifier" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "modifier" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pricebook_entry" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "pricebook_entry" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "redemption_code" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "file_object" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "dify_binding_resource_idx" ON "dify_binding" USING btree ("resource_id");--> statement-breakpoint
CREATE INDEX "resource_tenant_idx" ON "resource" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "resource_version_resource_idx" ON "resource_version" USING btree ("resource_id");--> statement-breakpoint
CREATE INDEX "ledger_txn_tenant_idx" ON "ledger_txn" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "ledger_txn_account_idx" ON "ledger_txn" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "webhook_outbox_job_idx" ON "webhook_outbox" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "user_tenant_idx" ON "user" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "redemption_code_redeemed_by_tenant_idx" ON "redemption_code" USING btree ("redeemed_by_tenant");--> statement-breakpoint
ALTER TABLE "resource" ADD CONSTRAINT "resource_status_allowed" CHECK ("resource"."status" IN ('active', 'disabled'));--> statement-breakpoint
ALTER TABLE "upstream_channel" ADD CONSTRAINT "upstream_channel_status_allowed" CHECK ("upstream_channel"."status" IN ('active', 'disabled'));--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_status_allowed" CHECK ("job"."status" IN ('queued', 'running', 'succeeded', 'failed', 'canceled'));--> statement-breakpoint
ALTER TABLE "webhook_outbox" ADD CONSTRAINT "webhook_outbox_status_allowed" CHECK ("webhook_outbox"."status" IN ('pending', 'sent', 'dead'));--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_status_allowed" CHECK ("api_key"."status" IN ('active', 'disabled'));--> statement-breakpoint
ALTER TABLE "model" ADD CONSTRAINT "model_status_allowed" CHECK ("model"."status" IN ('active', 'disabled'));--> statement-breakpoint
ALTER TABLE "oauth_session" ADD CONSTRAINT "oauth_session_status_allowed" CHECK ("oauth_session"."status" IN ('active', 'needs_reauth'));--> statement-breakpoint
ALTER TABLE "payment_intent" ADD CONSTRAINT "payment_intent_status_allowed" CHECK ("payment_intent"."status" IN ('created', 'pending', 'succeeded', 'failed', 'expired', 'refunded'));--> statement-breakpoint
ALTER TABLE "gift_code" ADD CONSTRAINT "gift_code_status_allowed" CHECK ("gift_code"."status" IN ('active', 'redeemed', 'expired', 'disabled'));--> statement-breakpoint
ALTER TABLE "redemption_code" ADD CONSTRAINT "redemption_code_status_allowed" CHECK ("redemption_code"."status" IN ('unused', 'redeemed'));--> statement-breakpoint
ALTER TABLE "file_object" ADD CONSTRAINT "file_object_status_allowed" CHECK ("file_object"."status" IN ('pending', 'ready'));--> statement-breakpoint
ALTER TABLE "usage_log" ADD CONSTRAINT "usage_log_status_allowed" CHECK ("usage_log"."status" IN ('succeeded', 'failed', 'canceled'));