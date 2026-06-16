CREATE TABLE "model" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"display" text,
	"modality" text DEFAULT 'chat' NOT NULL,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"visibility" text DEFAULT 'public' NOT NULL,
	"resource_id" text NOT NULL,
	"input_price" bigint DEFAULT 0 NOT NULL,
	"output_price" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_grant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model" ADD CONSTRAINT "model_resource_id_resource_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resource"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_grant" ADD CONSTRAINT "model_grant_model_id_model_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."model"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_grant" ADD CONSTRAINT "model_grant_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "model_name_idx" ON "model" USING btree ("name");--> statement-breakpoint
CREATE INDEX "model_resource_idx" ON "model" USING btree ("resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "model_grant_model_tenant_idx" ON "model_grant" USING btree ("model_id","tenant_id");