CREATE TABLE "leader_activity" (
	"id" serial PRIMARY KEY NOT NULL,
	"signature" text NOT NULL,
	"leader" text NOT NULL,
	"instruction" text NOT NULL,
	"action" text,
	"deposit_sol" double precision DEFAULT 0 NOT NULL,
	"withdraw_sol" double precision DEFAULT 0 NOT NULL,
	"claim_sol" double precision DEFAULT 0 NOT NULL,
	"pool" text,
	"non_sol_mint" text,
	"non_sol_symbol" text,
	"block_time" bigint,
	"source" text NOT NULL,
	"detected_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_leader_activity_signature" ON "leader_activity" USING btree ("signature");--> statement-breakpoint
CREATE INDEX "idx_leader_activity_leader" ON "leader_activity" USING btree ("leader");