CREATE TABLE "executions" (
	"command_id" text PRIMARY KEY NOT NULL,
	"event_key" text NOT NULL,
	"state" text NOT NULL,
	"deadline_slot" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
