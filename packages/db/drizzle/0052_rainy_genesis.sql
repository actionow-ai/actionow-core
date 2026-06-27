ALTER TABLE "provider_plugin" DROP CONSTRAINT "provider_plugin_slug_unique";--> statement-breakpoint
DROP INDEX "provider_plugin_slug_idx";--> statement-breakpoint
DROP INDEX "account_tenant_unique";--> statement-breakpoint
DROP INDEX "usage_log_model_idx";--> statement-breakpoint
DROP INDEX "usage_log_subject_idx";--> statement-breakpoint
ALTER TABLE "dify_binding" ADD CONSTRAINT "dify_binding_dify_service_key_ref_secret_ref_id_fk" FOREIGN KEY ("dify_service_key_ref") REFERENCES "public"."secret_ref"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upstream_channel" ADD CONSTRAINT "upstream_channel_credential_ref_secret_ref_id_fk" FOREIGN KEY ("credential_ref") REFERENCES "public"."secret_ref"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_pricebook_entry_id_pricebook_entry_id_fk" FOREIGN KEY ("pricebook_entry_id") REFERENCES "public"."pricebook_entry"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_created_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_log_target_idx" ON "audit_log" USING btree ("target_type","target_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "dify_binding_resource_version_uq" ON "dify_binding" USING btree ("resource_id","resource_version") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "secret_ref_provider_locator_idx" ON "secret_ref" USING btree ("provider","locator");--> statement-breakpoint
CREATE INDEX "job_due_idx" ON "job" USING btree ("hold_expires_at") WHERE hold_expires_at IS NOT NULL AND status IN ('queued', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "provider_plugin_slug_uq" ON "provider_plugin" USING btree ("slug") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "relay_trace_created_idx" ON "relay_trace" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "usage_log_api_key_idx" ON "usage_log" USING btree ("api_key_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "account_tenant_unique" ON "account" USING btree ("tenant_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "usage_log_model_idx" ON "usage_log" USING btree ("model","created_at");--> statement-breakpoint
CREATE INDEX "usage_log_subject_idx" ON "usage_log" USING btree ("subject_id","created_at");--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_balance_ge0" CHECK ("account"."credit_balance" >= 0);--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_held_ge0" CHECK ("account"."credit_held" >= 0);--> statement-breakpoint
ALTER TABLE "dify_binding" ADD CONSTRAINT "dify_binding_mode_allowed" CHECK ("dify_binding"."mode" IN ('workflow', 'advanced-chat'));--> statement-breakpoint
ALTER TABLE "dify_binding" ADD CONSTRAINT "dify_binding_pricing_model_allowed" CHECK ("dify_binding"."pricing_model" IN ('metered', 'fixed', 'matrix'));--> statement-breakpoint
ALTER TABLE "dify_binding" ADD CONSTRAINT "dify_binding_provision_mode_allowed" CHECK ("dify_binding"."provision_mode" IN ('byo', 'hosted'));--> statement-breakpoint
ALTER TABLE "secret_ref" ADD CONSTRAINT "secret_ref_provider_allowed" CHECK ("secret_ref"."provider" IN ('env', 'enc', 'oauth', 'vault'));--> statement-breakpoint
ALTER TABLE "ledger_txn" ADD CONSTRAINT "ledger_txn_type_allowed" CHECK ("ledger_txn"."type" IN ('topup', 'settle', 'hold', 'refund', 'giftcode', 'transfer_in', 'transfer_out'));--> statement-breakpoint
ALTER TABLE "subject" ADD CONSTRAINT "subject_addressable" CHECK ("subject"."external_id" IS NOT NULL OR "subject"."email" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "model" ADD CONSTRAINT "model_visibility_allowed" CHECK ("model"."visibility" IN ('public', 'tenant'));--> statement-breakpoint
-- Append-only enforcement (hand-written; drizzle-kit cannot model triggers).
-- ledger_txn + audit_log are the system-of-record moat: a bug or a compromised app
-- role must not be able to rewrite or erase history. Block DELETE outright and block
-- UPDATEs that touch any immutable business column — but PERMIT the FK→NULL update
-- that an ON DELETE SET NULL cascade performs when a referenced tenant/subject/job is
-- removed (the record must survive its parent). INSERT is always allowed; TRUNCATE
-- does not fire row triggers (test cleanup uses it).
CREATE OR REPLACE FUNCTION ledger_txn_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ledger_txn is append-only: DELETE is not permitted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.type IS DISTINCT FROM OLD.type
     OR NEW.credits_delta IS DISTINCT FROM OLD.credits_delta
     OR NEW.balance_after IS DISTINCT FROM OLD.balance_after
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'ledger_txn is append-only: financial columns are immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW; -- only job_id / subject_id (FK SET NULL) may change
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'audit_log is append-only: DELETE is not permitted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.actor_type IS DISTINCT FROM OLD.actor_type
     OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
     OR NEW.action IS DISTINCT FROM OLD.action
     OR NEW.target_type IS DISTINCT FROM OLD.target_type
     OR NEW.target_id IS DISTINCT FROM OLD.target_id
     OR NEW.meta IS DISTINCT FROM OLD.meta
     OR NEW.request_id IS DISTINCT FROM OLD.request_id THEN
    RAISE EXCEPTION 'audit_log is append-only: record columns are immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW; -- only tenant_id / subject_id (FK SET NULL) may change
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER ledger_txn_append_only BEFORE UPDATE OR DELETE ON "ledger_txn"
  FOR EACH ROW EXECUTE FUNCTION ledger_txn_append_only();--> statement-breakpoint
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();