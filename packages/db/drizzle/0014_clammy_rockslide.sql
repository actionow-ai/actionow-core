CREATE TABLE "relay_trace" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid,
	"job_id" uuid,
	"channel_id" uuid,
	"provider_type" text,
	"method" text NOT NULL,
	"url" text NOT NULL,
	"request_headers" jsonb,
	"request_body" text,
	"response_status" integer,
	"response_body" text,
	"is_stream" boolean DEFAULT false NOT NULL,
	"latency_ms" bigint,
	"error" text,
	"truncated" boolean DEFAULT false NOT NULL
);
