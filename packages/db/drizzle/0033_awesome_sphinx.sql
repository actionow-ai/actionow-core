CREATE TABLE "channel_model" (
	"channel_id" uuid NOT NULL,
	"model_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_model_channel_id_model_id_pk" PRIMARY KEY("channel_id","model_id")
);
--> statement-breakpoint
ALTER TABLE "channel_model" ADD CONSTRAINT "channel_model_channel_id_upstream_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."upstream_channel"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_model" ADD CONSTRAINT "channel_model_model_id_model_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."model"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_model_model_idx" ON "channel_model" USING btree ("model_id");--> statement-breakpoint
CREATE INDEX "channel_model_channel_idx" ON "channel_model" USING btree ("channel_id");--> statement-breakpoint
-- Backfill: link every existing (channel, model) sharing a platform so day-1
-- routing is unchanged (any channel served any of its platform's models). Sync
-- + operator edits refine the links afterwards.
INSERT INTO "channel_model" ("channel_id", "model_id")
SELECT c."id", m."id"
FROM "upstream_channel" c
JOIN "model" m ON m."resource_id" = c."resource_id"
WHERE c."deleted_at" IS NULL AND m."deleted_at" IS NULL
ON CONFLICT DO NOTHING;