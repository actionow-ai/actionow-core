DROP INDEX "idempotency_tenant_key";--> statement-breakpoint
ALTER TABLE "idempotency_key" ADD COLUMN "subject_id" uuid;--> statement-breakpoint
ALTER TABLE "idempotency_key" ADD CONSTRAINT "idempotency_key_subject_id_subject_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subject"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_tenant_subject_key" ON "idempotency_key" USING btree ("tenant_id","subject_id","key") WHERE subject_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_tenant_key" ON "idempotency_key" USING btree ("tenant_id","key") WHERE subject_id IS NULL;