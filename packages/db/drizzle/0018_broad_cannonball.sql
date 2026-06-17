DROP INDEX "model_name_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "model_name_idx" ON "model" USING btree ("name") WHERE deleted_at IS NULL;