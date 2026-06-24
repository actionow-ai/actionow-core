CREATE TABLE "subject" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"external_id" text,
	"email" text,
	"password_hash" text,
	"display_name" text,
	"limit_plan_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "subject_status_allowed" CHECK ("subject"."status" IN ('active', 'disabled'))
);
--> statement-breakpoint
ALTER TABLE "subject" ADD CONSTRAINT "subject_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject" ADD CONSTRAINT "subject_limit_plan_id_limit_plan_id_fk" FOREIGN KEY ("limit_plan_id") REFERENCES "public"."limit_plan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "subject_tenant_idx" ON "subject" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subject_tenant_external_id_idx" ON "subject" USING btree ("tenant_id","external_id") WHERE external_id IS NOT NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "subject_tenant_email_idx" ON "subject" USING btree ("tenant_id","email") WHERE email IS NOT NULL AND deleted_at IS NULL;