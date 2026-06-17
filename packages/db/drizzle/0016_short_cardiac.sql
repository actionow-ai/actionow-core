ALTER TABLE "upstream_channel" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "modifier" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "pricebook_entry" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;