CREATE TABLE "task" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"api_key_id" uuid,
	"subject_id" uuid,
	"operation" text NOT NULL,
	"model_id" uuid,
	"offering_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"internal_substate" text,
	"progress" integer,
	"fetch_mode" text,
	"upstream_task_id" text,
	"owner_node" text,
	"lease_until" timestamp with time zone,
	"max_run_time_seconds" integer,
	"hold_expires_at" timestamp with time zone,
	"hold_amount" bigint,
	"account_id" uuid,
	"sub_account_id" uuid,
	"estimated" boolean DEFAULT false NOT NULL,
	"sale_card_ref" jsonb,
	"cost_card_ref" jsonb,
	"artifact_mode" text,
	"artifact_expires_at" timestamp with time zone,
	"request_fingerprint" text,
	"idempotency_key" text,
	"callback_url" text,
	"inputs" jsonb NOT NULL,
	"output" jsonb,
	"usage" jsonb,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "task_status_allowed" CHECK ("task"."status" IN ('pending', 'running', 'succeeded', 'failed', 'canceled', 'expired')),
	CONSTRAINT "task_progress_range" CHECK ("task"."progress" BETWEEN 0 AND 100),
	CONSTRAINT "task_fetch_mode_allowed" CHECK ("task"."fetch_mode" IN ('direct', 'stream', 'submit_poll', 'submit_callback')),
	CONSTRAINT "task_artifact_mode_allowed" CHECK ("task"."artifact_mode" IN ('signed', 'public'))
);
--> statement-breakpoint
CREATE TABLE "task_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"evt_id" text NOT NULL,
	"event_type" text NOT NULL,
	"url" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"signature" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_deliveries_status_allowed" CHECK ("webhook_deliveries"."status" IN ('pending', 'sent', 'dead'))
);
--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_api_key_id_api_key_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_key"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_subject_id_subject_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subject"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_model_id_supply_model_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."supply_model"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_offering_id_supply_offering_id_fk" FOREIGN KEY ("offering_id") REFERENCES "public"."supply_offering"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_sub_account_id_sub_account_id_fk" FOREIGN KEY ("sub_account_id") REFERENCES "public"."sub_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_tenant_created_idx" ON "task" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "task_live_status_idx" ON "task" USING btree ("status") WHERE status IN ('pending', 'running');--> statement-breakpoint
CREATE INDEX "task_lease_idx" ON "task" USING btree ("lease_until") WHERE lease_until IS NOT NULL;--> statement-breakpoint
CREATE INDEX "task_hold_due_idx" ON "task" USING btree ("hold_expires_at") WHERE hold_expires_at IS NOT NULL AND status IN ('pending', 'running');--> statement-breakpoint
CREATE INDEX "task_upstream_idx" ON "task" USING btree ("upstream_task_id") WHERE upstream_task_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "task_idempotency_uq" ON "task" USING btree ("tenant_id","api_key_id","idempotency_key") WHERE idempotency_key IS NOT NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "task_events_task_seq_uq" ON "task_events" USING btree ("task_id","seq");--> statement-breakpoint
CREATE INDEX "task_events_created_idx" ON "task_events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_task_evt_uq" ON "webhook_deliveries" USING btree ("task_id","evt_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_due_idx" ON "webhook_deliveries" USING btree ("next_attempt_at") WHERE status = 'pending';--> statement-breakpoint
-- Append-only enforcement (hand-written; drizzle-kit cannot model triggers — the
-- mig 0052 pattern). task_events is the task state machine's immutable event
-- stream (design §7.1): a written observation is never rewritten, so block
-- UPDATE outright. Unlike ledger_txn/audit_log there is no ON DELETE SET NULL
-- FK to permit (task_id is NOT NULL and tasks are soft-deleted, never
-- hard-deleted), and DELETE is deliberately ALLOWED: task_events carries a
-- retention policy (§7.1/§9.3 — deleteTaskEventsOlderThan sweeps rows older
-- than TASK_EVENTS_RETENTION_DAYS), so the reaper must be able to prune. It is
-- an observability stream, not the financial system-of-record. INSERT is always
-- allowed; TRUNCATE does not fire row triggers (test cleanup uses it).
CREATE OR REPLACE FUNCTION task_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'task_events is append-only: UPDATE is not permitted'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER task_events_append_only BEFORE UPDATE ON "task_events"
  FOR EACH ROW EXECUTE FUNCTION task_events_append_only();