CREATE TABLE "admin_token" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"expires_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "admin_token_status_allowed" CHECK ("admin_token"."status" IN ('active', 'disabled'))
);
--> statement-breakpoint
ALTER TABLE "admin_token" ADD CONSTRAINT "admin_token_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_token_hash_idx" ON "admin_token" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "admin_token_created_by_idx" ON "admin_token" USING btree ("created_by");