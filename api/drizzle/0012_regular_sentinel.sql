CREATE TABLE "rpc_credit_daily" (
	"day" integer NOT NULL,
	"method" text NOT NULL,
	"wallet" text DEFAULT '' NOT NULL,
	"code_path" text NOT NULL,
	"calls" bigint DEFAULT 0 NOT NULL,
	"credits" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "rpc_credit_daily_day_method_wallet_code_path_pk" PRIMARY KEY("day","method","wallet","code_path")
);
--> statement-breakpoint
CREATE TABLE "swap_flow_cursor" (
	"wallet" text PRIMARY KEY NOT NULL,
	"oldest_sig" text,
	"newest_sig" text,
	"complete" boolean DEFAULT false NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "swap_flows" (
	"wallet" text NOT NULL,
	"signature" text NOT NULL,
	"ts" bigint NOT NULL,
	"mint" text NOT NULL,
	"token_amount" double precision NOT NULL,
	"sol_amount" double precision NOT NULL,
	"side" text NOT NULL,
	CONSTRAINT "swap_flows_wallet_signature_mint_pk" PRIMARY KEY("wallet","signature","mint")
);
--> statement-breakpoint
CREATE TABLE "wallet_stream_cursor" (
	"wallet" text PRIMARY KEY NOT NULL,
	"last_signature" text,
	"last_slot" bigint,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_swap_flows_wallet_ts" ON "swap_flows" USING btree ("wallet","ts");