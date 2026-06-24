ALTER TABLE "job" ADD COLUMN "subject_id" uuid;--> statement-breakpoint
ALTER TABLE "ledger_txn" ADD COLUMN "subject_id" uuid;--> statement-breakpoint
ALTER TABLE "webhook_outbox" ADD COLUMN "subject_id" uuid;--> statement-breakpoint
ALTER TABLE "api_key" ADD COLUMN "subject_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_intent" ADD COLUMN "subject_id" uuid;--> statement-breakpoint
ALTER TABLE "redemption_code" ADD COLUMN "subject_id" uuid;--> statement-breakpoint
ALTER TABLE "relay_trace" ADD COLUMN "subject_id" uuid;--> statement-breakpoint
ALTER TABLE "file_object" ADD COLUMN "subject_id" uuid;--> statement-breakpoint
ALTER TABLE "usage_log" ADD COLUMN "subject_id" uuid;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_subject_id_subject_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subject"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_txn" ADD CONSTRAINT "ledger_txn_subject_id_subject_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subject"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_outbox" ADD CONSTRAINT "webhook_outbox_subject_id_subject_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subject"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_subject_id_subject_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subject"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intent" ADD CONSTRAINT "payment_intent_subject_id_subject_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subject"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redemption_code" ADD CONSTRAINT "redemption_code_subject_id_subject_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subject"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_object" ADD CONSTRAINT "file_object_subject_id_subject_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subject"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_log" ADD CONSTRAINT "usage_log_subject_id_subject_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subject"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_subject_idx" ON "job" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "ledger_txn_subject_idx" ON "ledger_txn" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "webhook_outbox_subject_idx" ON "webhook_outbox" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "api_key_subject_idx" ON "api_key" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "payment_intent_subject_idx" ON "payment_intent" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "redemption_code_subject_idx" ON "redemption_code" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "relay_trace_subject_idx" ON "relay_trace" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "file_object_subject_idx" ON "file_object" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "usage_log_subject_idx" ON "usage_log" USING btree ("subject_id");