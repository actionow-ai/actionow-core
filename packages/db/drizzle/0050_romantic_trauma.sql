DROP INDEX "limit_plan_name_idx";--> statement-breakpoint
ALTER TABLE "limit_plan" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "limit_plan" ADD CONSTRAINT "limit_plan_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
--> HAND-EDIT: `NULLS NOT DISTINCT` is appended by hand (drizzle-orm 0.45.2 /
--> drizzle-kit 0.31.10 can't emit it for an index) so platform plans
--> (tenant_id NULL) stay name-unique among themselves. Keep on regenerate.
CREATE UNIQUE INDEX "limit_plan_tenant_name_idx" ON "limit_plan" USING btree ("tenant_id","name") NULLS NOT DISTINCT WHERE deleted_at IS NULL;