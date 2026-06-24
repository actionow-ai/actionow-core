CREATE TABLE "subject_identity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subject_identity" ADD CONSTRAINT "subject_identity_subject_id_subject_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subject"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "subject_identity_provider_sub_subject_idx" ON "subject_identity" USING btree ("provider","provider_user_id","subject_id");--> statement-breakpoint
CREATE INDEX "subject_identity_provider_user_idx" ON "subject_identity" USING btree ("provider","provider_user_id");--> statement-breakpoint
CREATE INDEX "subject_identity_subject_idx" ON "subject_identity" USING btree ("subject_id");