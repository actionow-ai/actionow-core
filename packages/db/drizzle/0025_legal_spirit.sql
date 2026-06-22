ALTER TABLE "secret_ref" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "secret_ref" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "secret_ref" ADD COLUMN "group_tag" text;--> statement-breakpoint
ALTER TABLE "oauth_session" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "oauth_session" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "oauth_session" ADD COLUMN "group_tag" text;