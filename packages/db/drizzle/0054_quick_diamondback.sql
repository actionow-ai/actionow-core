ALTER TABLE "dify_binding" DROP CONSTRAINT "dify_binding_dify_service_key_ref_secret_ref_id_fk";
--> statement-breakpoint
ALTER TABLE "upstream_channel" DROP CONSTRAINT "upstream_channel_credential_ref_secret_ref_id_fk";
