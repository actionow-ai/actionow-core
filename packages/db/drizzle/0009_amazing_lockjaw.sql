CREATE TABLE "channel_health" (
	"channel_id" uuid PRIMARY KEY NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"cooldown_until" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_health" ADD CONSTRAINT "channel_health_channel_id_upstream_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."upstream_channel"("id") ON DELETE no action ON UPDATE no action;