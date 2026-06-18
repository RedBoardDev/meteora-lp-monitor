CREATE TABLE "wallet_flow_cursor" (
	"wallet" text PRIMARY KEY NOT NULL,
	"oldest_sig" text,
	"newest_sig" text,
	"complete" boolean DEFAULT false NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_flows" (
	"wallet" text NOT NULL,
	"signature" text NOT NULL,
	"ts" bigint NOT NULL,
	"sol_flow" double precision NOT NULL,
	"is_trading" boolean NOT NULL,
	"type" text NOT NULL,
	CONSTRAINT "wallet_flows_wallet_signature_pk" PRIMARY KEY("wallet","signature")
);
--> statement-breakpoint
CREATE INDEX "idx_wallet_flows_wallet_ts" ON "wallet_flows" USING btree ("wallet","ts");