CREATE TABLE "redemption_code" (
	"code" text PRIMARY KEY NOT NULL,
	"credit_amount" bigint NOT NULL,
	"status" text DEFAULT 'unused' NOT NULL,
	"redeemed_by_tenant" uuid,
	"redeemed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "redemption_code" ADD CONSTRAINT "redemption_code_redeemed_by_tenant_tenant_id_fk" FOREIGN KEY ("redeemed_by_tenant") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;