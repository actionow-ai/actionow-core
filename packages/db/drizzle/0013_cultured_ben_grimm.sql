CREATE TABLE "oauth_session" (
	"secret_ref_id" uuid PRIMARY KEY NOT NULL,
	"provider_kind" text NOT NULL,
	"account_label" text,
	"account_id" text,
	"access_enc" text NOT NULL,
	"refresh_enc" text NOT NULL,
	"expires_at" timestamp with time zone,
	"last_refresh_at" timestamp with time zone,
	"refresh_lock_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "oauth_session" ADD CONSTRAINT "oauth_session_secret_ref_id_secret_ref_id_fk" FOREIGN KEY ("secret_ref_id") REFERENCES "public"."secret_ref"("id") ON DELETE no action ON UPDATE no action;