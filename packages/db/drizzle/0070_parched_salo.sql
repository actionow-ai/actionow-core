CREATE TABLE "supply_offering_breaker" (
	"offering_id" uuid PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'closed' NOT NULL,
	"opened_at" timestamp with time zone,
	"half_open_successes" integer DEFAULT 0 NOT NULL,
	"consecutive_opens" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supply_offering_breaker_state_allowed" CHECK ("supply_offering_breaker"."state" IN ('closed', 'open', 'half_open'))
);
--> statement-breakpoint
ALTER TABLE "supply_offering_breaker" ADD CONSTRAINT "supply_offering_breaker_offering_id_supply_offering_id_fk" FOREIGN KEY ("offering_id") REFERENCES "public"."supply_offering"("id") ON DELETE cascade ON UPDATE no action;