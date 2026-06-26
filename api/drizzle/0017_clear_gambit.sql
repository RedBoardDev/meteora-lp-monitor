CREATE TABLE "copybot_status" (
	"process" text PRIMARY KEY NOT NULL,
	"ts" bigint NOT NULL,
	"detail" jsonb
);
