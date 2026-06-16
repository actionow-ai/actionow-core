ALTER TABLE "job" ADD COLUMN "account_id" uuid;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_tenant_unique" ON "account" USING btree ("tenant_id");--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_role_allowed" CHECK ("user"."role" IN ('user', 'admin'));