ALTER TABLE "user" ADD COLUMN "tenant_role" text;--> statement-breakpoint
CREATE INDEX "user_tenant_role_idx" ON "user" USING btree ("tenant_id","tenant_role");--> statement-breakpoint
UPDATE "user" SET "tenant_role" = 'admin' WHERE "role" = 'user';--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_tenant_role_allowed" CHECK (("user"."role" = 'admin' AND "user"."tenant_role" IS NULL) OR ("user"."role" = 'user' AND "user"."tenant_role" IS NOT NULL AND "user"."tenant_role" IN ('admin','member')));