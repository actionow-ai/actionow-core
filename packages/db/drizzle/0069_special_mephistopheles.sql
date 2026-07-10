CREATE TABLE "supply_channel" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"name" text NOT NULL,
	"dialect" jsonb,
	"base_url" text,
	"proxy_ref" text,
	"region" text,
	"auth_scheme" text NOT NULL,
	"tenant_id" uuid,
	"route_group_id" uuid,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "supply_channel_auth_scheme_allowed" CHECK ("supply_channel"."auth_scheme" IN ('bearer', 'x_api_key', 'query', 'ak_sk', 'oauth')),
	CONSTRAINT "supply_channel_status_allowed" CHECK ("supply_channel"."status" IN ('active', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "supply_credential" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"name" text NOT NULL,
	"secret_ref_id" uuid NOT NULL,
	"secret_hint" text,
	"quota" jsonb DEFAULT '{"rpm":null,"tpm":null,"max_concurrency":null}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"cooldown_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "supply_credential_status_allowed" CHECK ("supply_credential"."status" IN ('active', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "supply_model" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"display_name" text NOT NULL,
	"icon" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"modality" text NOT NULL,
	"operations" jsonb NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"price_card_id" uuid,
	"modifier_group_id" uuid,
	"max_run_time_seconds" integer,
	"artifact" jsonb DEFAULT '{"mode":"signed","retention_days":null}'::jsonb NOT NULL,
	"fallback_model_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"limit_plan_id" uuid,
	"visibility" text DEFAULT 'public' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "supply_model_status_allowed" CHECK ("supply_model"."status" IN ('draft', 'active', 'deprecated', 'disabled')),
	CONSTRAINT "supply_model_visibility_allowed" CHECK ("supply_model"."visibility" IN ('public', 'granted'))
);
--> statement-breakpoint
CREATE TABLE "supply_model_grant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supply_offering" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"upstream_model_name" text NOT NULL,
	"fetch_profile" jsonb NOT NULL,
	"timeout_budget_seconds" integer,
	"param_declarations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cost_price_card_id" uuid,
	"max_concurrency" integer,
	"weight" integer DEFAULT 1 NOT NULL,
	"tier" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "supply_offering_status_allowed" CHECK ("supply_offering"."status" IN ('draft', 'probing', 'enabled', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "supply_price_card" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"method" text NOT NULL,
	"unit" text NOT NULL,
	"tier_dims" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"spec" jsonb NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"effective_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "supply_price_card_method_allowed" CHECK ("supply_price_card"."method" IN ('unit', 'matrix', 'fixed', 'formula', 'passthrough', 'model_token', 'credits'))
);
--> statement-breakpoint
CREATE TABLE "supply_provider" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"icon" text,
	"default_dialect" jsonb NOT NULL,
	"callback_verification" jsonb,
	"default_fault_policy_id" uuid,
	"region" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "api_key" ADD COLUMN "model_allowlist" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "supply_channel" ADD CONSTRAINT "supply_channel_provider_id_supply_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."supply_provider"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_channel" ADD CONSTRAINT "supply_channel_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_channel" ADD CONSTRAINT "supply_channel_route_group_id_route_group_id_fk" FOREIGN KEY ("route_group_id") REFERENCES "public"."route_group"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_credential" ADD CONSTRAINT "supply_credential_channel_id_supply_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."supply_channel"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_credential" ADD CONSTRAINT "supply_credential_secret_ref_id_secret_ref_id_fk" FOREIGN KEY ("secret_ref_id") REFERENCES "public"."secret_ref"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_model" ADD CONSTRAINT "supply_model_price_card_id_supply_price_card_id_fk" FOREIGN KEY ("price_card_id") REFERENCES "public"."supply_price_card"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_model" ADD CONSTRAINT "supply_model_limit_plan_id_limit_plan_id_fk" FOREIGN KEY ("limit_plan_id") REFERENCES "public"."limit_plan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_model_grant" ADD CONSTRAINT "supply_model_grant_model_id_supply_model_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."supply_model"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_model_grant" ADD CONSTRAINT "supply_model_grant_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_offering" ADD CONSTRAINT "supply_offering_model_id_supply_model_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."supply_model"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_offering" ADD CONSTRAINT "supply_offering_channel_id_supply_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."supply_channel"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_offering" ADD CONSTRAINT "supply_offering_cost_price_card_id_supply_price_card_id_fk" FOREIGN KEY ("cost_price_card_id") REFERENCES "public"."supply_price_card"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_provider" ADD CONSTRAINT "supply_provider_default_fault_policy_id_fault_policy_id_fk" FOREIGN KEY ("default_fault_policy_id") REFERENCES "public"."fault_policy"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "supply_channel_provider_idx" ON "supply_channel" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "supply_channel_tenant_idx" ON "supply_channel" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "supply_credential_channel_idx" ON "supply_credential" USING btree ("channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supply_model_name_idx" ON "supply_model" USING btree ("name") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "supply_model_grant_model_tenant_idx" ON "supply_model_grant" USING btree ("model_id","tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supply_offering_model_channel_idx" ON "supply_offering" USING btree ("model_id","channel_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "supply_offering_model_idx" ON "supply_offering" USING btree ("model_id");--> statement-breakpoint
CREATE INDEX "supply_offering_channel_idx" ON "supply_offering" USING btree ("channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supply_provider_slug_idx" ON "supply_provider" USING btree ("slug") WHERE deleted_at IS NULL;