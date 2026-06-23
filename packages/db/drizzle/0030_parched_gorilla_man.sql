CREATE TABLE "proxy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"scheme" text NOT NULL,
	"host" text NOT NULL,
	"encrypted_url" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"healthy" boolean,
	"last_checked_at" timestamp with time zone,
	"last_latency_ms" integer,
	"last_error" text,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "proxy_status_allowed" CHECK ("proxy"."status" IN ('active', 'disabled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "proxy_name_idx" ON "proxy" USING btree ("name") WHERE deleted_at IS NULL;