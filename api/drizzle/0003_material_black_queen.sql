CREATE TABLE "dlmm_ingest_cursor" (
	"wallet" text PRIMARY KEY NOT NULL,
	"oldest_sig" text,
	"newest_sig" text,
	"complete" boolean DEFAULT false NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dlmm_legs" (
	"id" serial PRIMARY KEY NOT NULL,
	"signature" text NOT NULL,
	"wallet" text NOT NULL,
	"position" text NOT NULL,
	"lb_pair" text NOT NULL,
	"kind" text NOT NULL,
	"active_bin_id" integer NOT NULL,
	"amount_x" text NOT NULL,
	"amount_y" text NOT NULL,
	"block_time" bigint
);
--> statement-breakpoint
CREATE INDEX "idx_dlmm_legs_wallet" ON "dlmm_legs" USING btree ("wallet");--> statement-breakpoint
CREATE INDEX "idx_dlmm_legs_position" ON "dlmm_legs" USING btree ("position");--> statement-breakpoint
CREATE INDEX "idx_dlmm_legs_signature" ON "dlmm_legs" USING btree ("signature");