CREATE TABLE "request_idempotency" (
	"id_key" text NOT NULL,
	"scope" text NOT NULL,
	"response_status" integer NOT NULL,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "request_idempotency_id_key_scope_pk" PRIMARY KEY("id_key","scope")
);
