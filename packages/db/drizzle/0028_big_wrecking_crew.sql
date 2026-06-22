CREATE TABLE "provider_plugin_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"manifest" jsonb NOT NULL,
	"handler" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "provider_plugin_version" ADD CONSTRAINT "provider_plugin_version_plugin_id_provider_plugin_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."provider_plugin"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_plugin_version_uq" ON "provider_plugin_version" USING btree ("plugin_id","version");