CREATE TABLE "networth_snapshots" (
	"wallet" text NOT NULL,
	"bucket" integer NOT NULL,
	"ts" bigint NOT NULL,
	"wallet_total_sol" double precision NOT NULL,
	"tvl_sol" double precision NOT NULL,
	"idle_sol" double precision NOT NULL,
	CONSTRAINT "networth_snapshots_wallet_bucket_pk" PRIMARY KEY("wallet","bucket")
);
