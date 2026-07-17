-- 批次6 D4 (旧世界删除 · 切换预案④ 步骤7): DROP the 12 old-world tables.
-- HAND-REORDERED after `drizzle-kit generate`: the 3 kept-table FK constraints
-- (ledger_txn / channel_breaker / route_group_channel → dying tables) are
-- dropped FIRST — drizzle emitted them AFTER the `DROP TABLE ... CASCADE`
-- statements, but CASCADE on `job` / `upstream_channel` already removes those
-- constraints implicitly, so the trailing explicit DROP CONSTRAINT would fail.
-- Kept assets are untouched: `ledger_txn` keeps its `job_id` COLUMN (historical
-- settle attribution) and the `ledger_settle_per_job` partial unique index;
-- `channel_breaker` / `route_group_channel` keep their `channel_id` columns.
ALTER TABLE "ledger_txn" DROP CONSTRAINT "ledger_txn_job_id_job_id_fk";--> statement-breakpoint
ALTER TABLE "channel_breaker" DROP CONSTRAINT "channel_breaker_channel_id_upstream_channel_id_fk";--> statement-breakpoint
ALTER TABLE "route_group_channel" DROP CONSTRAINT "route_group_channel_channel_id_upstream_channel_id_fk";--> statement-breakpoint
ALTER TABLE "dify_binding" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "resource" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "resource_version" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "upstream_channel" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "job" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "webhook_outbox" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "channel_model" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "model" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "model_grant" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "provider_plugin" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "provider_plugin_version" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pricebook_entry" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "dify_binding" CASCADE;--> statement-breakpoint
DROP TABLE "resource_version" CASCADE;--> statement-breakpoint
DROP TABLE "channel_model" CASCADE;--> statement-breakpoint
DROP TABLE "model_grant" CASCADE;--> statement-breakpoint
DROP TABLE "model" CASCADE;--> statement-breakpoint
DROP TABLE "job" CASCADE;--> statement-breakpoint
DROP TABLE "webhook_outbox" CASCADE;--> statement-breakpoint
DROP TABLE "upstream_channel" CASCADE;--> statement-breakpoint
DROP TABLE "pricebook_entry" CASCADE;--> statement-breakpoint
DROP TABLE "resource" CASCADE;--> statement-breakpoint
DROP TABLE "provider_plugin_version" CASCADE;--> statement-breakpoint
DROP TABLE "provider_plugin" CASCADE;