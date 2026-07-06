CREATE TABLE "redemption_claim" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject_id" uuid,
	"credit_amount" bigint NOT NULL,
	"redeemed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "redemption_code" ADD COLUMN "max_uses" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "redemption_code" ADD COLUMN "redeemed_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "redemption_claim" ADD CONSTRAINT "redemption_claim_code_redemption_code_code_fk" FOREIGN KEY ("code") REFERENCES "public"."redemption_code"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redemption_claim" ADD CONSTRAINT "redemption_claim_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redemption_claim" ADD CONSTRAINT "redemption_claim_subject_id_subject_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subject"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "redemption_claim_code_tenant_unique" ON "redemption_claim" USING btree ("code","tenant_id");--> statement-breakpoint
CREATE INDEX "redemption_claim_code_idx" ON "redemption_claim" USING btree ("code");--> statement-breakpoint
CREATE INDEX "redemption_claim_tenant_idx" ON "redemption_claim" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "redemption_claim_subject_idx" ON "redemption_claim" USING btree ("subject_id");--> statement-breakpoint
ALTER TABLE "redemption_code" ADD CONSTRAINT "redemption_code_max_uses_ge1" CHECK ("redemption_code"."max_uses" >= 1);--> statement-breakpoint
ALTER TABLE "redemption_code" ADD CONSTRAINT "redemption_code_redeemed_count_valid" CHECK ("redemption_code"."redeemed_count" >= 0 AND "redemption_code"."redeemed_count" <= "redemption_code"."max_uses");--> statement-breakpoint
-- Backfill (data migration): an already-`redeemed` single-use code has been used
-- once. Without this its redeemed_count stays 0, and the multi-use claim gate
-- (`redeemed_count < max_uses`) would wrongly treat it as claimable again. Safe
-- under the count<=max_uses CHECK (1 <= 1 for the default single-use codes).
UPDATE "redemption_code" SET "redeemed_count" = 1 WHERE "status" = 'redeemed';