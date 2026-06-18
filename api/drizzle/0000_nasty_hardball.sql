CREATE TABLE "notif_rules" (
	"wallet" text,
	"event_kind" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"mode" text DEFAULT 'single' NOT NULL,
	"threshold" double precision,
	"oor_minutes" integer
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"position_address" text PRIMARY KEY NOT NULL,
	"wallet" text NOT NULL,
	"pool_address" text NOT NULL,
	"token_x" text,
	"token_y" text,
	"token_x_mint" text,
	"token_x_icon" text,
	"token_y_icon" text,
	"status" text NOT NULL,
	"strategy" text,
	"pnl_sol" double precision,
	"pnl_pct_sol" double precision,
	"size_sol" double precision,
	"deposit_sol" double precision,
	"withdraw_sol" double precision,
	"claimed_fees_sol" double precision,
	"unclaimed_fees_sol" double precision,
	"market_pnl_sol" double precision,
	"min_price" double precision,
	"max_price" double precision,
	"pool_price" double precision,
	"range_status" text,
	"oor_since" bigint,
	"opened_at" bigint,
	"closed_at" bigint,
	"duration_seconds" integer,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"address" text PRIMARY KEY NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"color" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_notif_rules_wallet_kind" ON "notif_rules" USING btree (coalesce("wallet", ''),"event_kind");--> statement-breakpoint
CREATE INDEX "idx_positions_wallet_status" ON "positions" USING btree ("wallet","status");--> statement-breakpoint
CREATE INDEX "idx_positions_wallet_closed_at" ON "positions" USING btree ("wallet","closed_at");--> statement-breakpoint
CREATE INDEX "idx_positions_status_closed_at" ON "positions" USING btree ("status","closed_at");