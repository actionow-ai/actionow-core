CREATE TABLE "limit_alert" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"rule_id" uuid NOT NULL,
	"dimension" text NOT NULL,
	"period_key" text NOT NULL,
	"used" bigint NOT NULL,
	"cap" bigint NOT NULL,
	"pct" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "limit_plan" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "limit_plan_status_allowed" CHECK ("limit_plan"."status" IN ('active', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "limit_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"dimension" text NOT NULL,
	"period" text,
	"cap" bigint NOT NULL,
	"model_scope" text,
	"alert_pct" integer,
	"enforce" text DEFAULT 'hard' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "limit_rule_dimension_allowed" CHECK ("limit_rule"."dimension" IN ('spend', 'requests', 'tokens', 'rpm', 'concurrency')),
	CONSTRAINT "limit_rule_period_allowed" CHECK ("limit_rule"."period" IS NULL OR "limit_rule"."period" IN ('minute', 'day', 'month', 'rolling_24h', 'rolling_30d', 'total')),
	CONSTRAINT "limit_rule_cap_ge0" CHECK ("limit_rule"."cap" >= 0),
	CONSTRAINT "limit_rule_alert_pct_range" CHECK ("limit_rule"."alert_pct" IS NULL OR ("limit_rule"."alert_pct" >= 1 AND "limit_rule"."alert_pct" <= 100))
);
--> statement-breakpoint
CREATE TABLE "limit_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"dimension" text NOT NULL,
	"period_key" text NOT NULL,
	"model_scope" text DEFAULT '' NOT NULL,
	"used" bigint DEFAULT 0 NOT NULL,
	"period_start" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "limit_plan_id" uuid;--> statement-breakpoint
ALTER TABLE "api_key" ADD COLUMN "limit_plan_id" uuid;--> statement-breakpoint
ALTER TABLE "limit_alert" ADD CONSTRAINT "limit_alert_rule_id_limit_rule_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."limit_rule"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "limit_rule" ADD CONSTRAINT "limit_rule_plan_id_limit_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."limit_plan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "limit_alert_subject_idx" ON "limit_alert" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "limit_alert_once_idx" ON "limit_alert" USING btree ("subject_type","subject_id","rule_id","period_key","pct");--> statement-breakpoint
CREATE UNIQUE INDEX "limit_plan_name_idx" ON "limit_plan" USING btree ("name") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "limit_rule_plan_idx" ON "limit_rule" USING btree ("plan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "limit_usage_unique" ON "limit_usage" USING btree ("subject_type","subject_id","dimension","period_key","model_scope");--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_limit_plan_id_limit_plan_id_fk" FOREIGN KEY ("limit_plan_id") REFERENCES "public"."limit_plan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_limit_plan_id_limit_plan_id_fk" FOREIGN KEY ("limit_plan_id") REFERENCES "public"."limit_plan"("id") ON DELETE no action ON UPDATE no action;