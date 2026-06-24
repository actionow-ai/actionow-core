CREATE TABLE "icon_asset" (
	"key" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"category" text DEFAULT 'provider' NOT NULL,
	"svg" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "upstream_channel" ADD COLUMN "icon" text;--> statement-breakpoint
ALTER TABLE "model" ADD COLUMN "icon" text;--> statement-breakpoint
ALTER TABLE "provider_plugin" ADD COLUMN "icon" text;