CREATE TABLE "route_group" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"group_ratio_bps" integer DEFAULT 10000 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "route_group_status_allowed" CHECK ("route_group"."status" IN ('active', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "route_group_channel" (
	"group_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"weight" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "route_group_channel_group_id_channel_id_pk" PRIMARY KEY("group_id","channel_id")
);
--> statement-breakpoint
ALTER TABLE "api_key" ADD COLUMN "route_group_id" uuid;--> statement-breakpoint
ALTER TABLE "route_group_channel" ADD CONSTRAINT "route_group_channel_group_id_route_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."route_group"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_group_channel" ADD CONSTRAINT "route_group_channel_channel_id_upstream_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."upstream_channel"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "route_group_name_idx" ON "route_group" USING btree ("name") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "route_group_channel_group_idx" ON "route_group_channel" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "route_group_channel_channel_idx" ON "route_group_channel" USING btree ("channel_id");--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_route_group_id_route_group_id_fk" FOREIGN KEY ("route_group_id") REFERENCES "public"."route_group"("id") ON DELETE no action ON UPDATE no action;