CREATE TABLE "channel_breaker" (
	"channel_id" uuid NOT NULL,
	"model" text NOT NULL,
	"state" text DEFAULT 'closed' NOT NULL,
	"opened_at" timestamp with time zone,
	"cooldown_until" timestamp with time zone,
	"trip_count" integer DEFAULT 0 NOT NULL,
	"half_open_successes" integer DEFAULT 0 NOT NULL,
	"last_failure_at" timestamp with time zone,
	"last_transition_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_breaker_channel_id_model_pk" PRIMARY KEY("channel_id","model"),
	CONSTRAINT "channel_breaker_state_allowed" CHECK ("channel_breaker"."state" IN ('closed','open','half_open'))
);
--> statement-breakpoint
ALTER TABLE "fault_policy" ADD COLUMN "breaker_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "fault_policy" ADD COLUMN "breaker_window_ms" integer;--> statement-breakpoint
ALTER TABLE "fault_policy" ADD COLUMN "breaker_min_volume" integer;--> statement-breakpoint
ALTER TABLE "fault_policy" ADD COLUMN "breaker_failure_rate_pct" integer;--> statement-breakpoint
ALTER TABLE "fault_policy" ADD COLUMN "breaker_half_open_trial" integer;--> statement-breakpoint
ALTER TABLE "fault_policy" ADD COLUMN "breaker_half_open_successes" integer;--> statement-breakpoint
ALTER TABLE "fault_policy" ADD COLUMN "breaker_open_cooldown_ms" integer;--> statement-breakpoint
ALTER TABLE "fault_policy" ADD COLUMN "breaker_open_cooldown_cap_ms" integer;--> statement-breakpoint
ALTER TABLE "route_group" ADD COLUMN "fallback_group_id" uuid;--> statement-breakpoint
ALTER TABLE "channel_breaker" ADD CONSTRAINT "channel_breaker_channel_id_upstream_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."upstream_channel"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_group" ADD CONSTRAINT "route_group_fallback_group_id_route_group_id_fk" FOREIGN KEY ("fallback_group_id") REFERENCES "public"."route_group"("id") ON DELETE no action ON UPDATE no action;