CREATE TABLE "provider_plugin" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"label" text NOT NULL,
	"modalities" text[] DEFAULT '{}'::text[] NOT NULL,
	"protocol" text NOT NULL,
	"auth_strategy" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"handler" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"builtin" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "provider_plugin_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "upstream_channel" ADD COLUMN "plugin_id" uuid;--> statement-breakpoint
ALTER TABLE "upstream_channel" ADD COLUMN "plugin_version" integer;--> statement-breakpoint
ALTER TABLE "upstream_channel" ADD COLUMN "trust" text DEFAULT 'trusted' NOT NULL;--> statement-breakpoint
ALTER TABLE "upstream_channel" ADD COLUMN "model_map" jsonb;--> statement-breakpoint
CREATE INDEX "provider_plugin_slug_idx" ON "provider_plugin" USING btree ("slug");--> statement-breakpoint
ALTER TABLE "upstream_channel" ADD CONSTRAINT "upstream_channel_plugin_id_provider_plugin_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."provider_plugin"("id") ON DELETE no action ON UPDATE no action;