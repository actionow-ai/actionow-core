ALTER TABLE "account" ADD COLUMN "config" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant" ADD COLUMN "config" jsonb DEFAULT '{}'::jsonb NOT NULL;