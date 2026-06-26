CREATE TABLE "copy_journal" (
	"id" serial PRIMARY KEY NOT NULL,
	"ts" bigint NOT NULL,
	"process" text NOT NULL,
	"stage" text NOT NULL,
	"outcome" text NOT NULL,
	"severity" text NOT NULL,
	"reason" text,
	"kind" text,
	"leader" text,
	"pool" text,
	"leader_position" text,
	"our_position" text,
	"command_id" text,
	"event_key" text,
	"leader_size_sol" double precision,
	"our_size_sol" double precision,
	"signature" text,
	"latency_ms" integer,
	"detail" jsonb
);
--> statement-breakpoint
CREATE INDEX "idx_copy_journal_ts" ON "copy_journal" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "idx_copy_journal_leader_ts" ON "copy_journal" USING btree ("leader","ts");--> statement-breakpoint
CREATE INDEX "idx_copy_journal_our_position" ON "copy_journal" USING btree ("our_position");