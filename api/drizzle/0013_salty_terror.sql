CREATE TABLE "copy_decisions" (
	"id" serial PRIMARY KEY NOT NULL,
	"signature" text NOT NULL,
	"leader" text NOT NULL,
	"pool" text,
	"position" text,
	"event_kind" text NOT NULL,
	"outcome" text NOT NULL,
	"skip_reason" text,
	"leader_size_sol" double precision DEFAULT 0 NOT NULL,
	"our_size_sol" double precision,
	"block_time" bigint,
	"decided_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_copy_decisions_signature" ON "copy_decisions" USING btree ("signature");--> statement-breakpoint
CREATE INDEX "idx_copy_decisions_leader" ON "copy_decisions" USING btree ("leader");