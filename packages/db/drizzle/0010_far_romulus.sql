CREATE TABLE "secret_material" (
	"secret_ref_id" uuid PRIMARY KEY NOT NULL,
	"material" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "secret_material" ADD CONSTRAINT "secret_material_secret_ref_id_secret_ref_id_fk" FOREIGN KEY ("secret_ref_id") REFERENCES "public"."secret_ref"("id") ON DELETE no action ON UPDATE no action;