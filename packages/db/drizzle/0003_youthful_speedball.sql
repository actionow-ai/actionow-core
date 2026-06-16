CREATE TABLE "payment_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_intent_id" uuid,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"type" text NOT NULL,
	"raw_payload" jsonb NOT NULL,
	"signature_ok" boolean NOT NULL,
	"processed_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_intent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_ref" text NOT NULL,
	"purpose" text NOT NULL,
	"target_ref" text,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"credit_amount" bigint,
	"status" text DEFAULT 'created' NOT NULL,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payment_intent" ADD CONSTRAINT "payment_intent_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_event_provider_event" ON "payment_event" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "payment_event_intent_idx" ON "payment_event" USING btree ("payment_intent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_intent_provider_ref" ON "payment_intent" USING btree ("provider","provider_ref");--> statement-breakpoint
CREATE INDEX "payment_intent_tenant_idx" ON "payment_intent" USING btree ("tenant_id");