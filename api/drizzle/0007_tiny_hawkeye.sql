CREATE TABLE "wallet_flow_daily" (
	"wallet" text NOT NULL,
	"day" integer NOT NULL,
	"trading" double precision NOT NULL,
	"external" double precision NOT NULL,
	CONSTRAINT "wallet_flow_daily_wallet_day_pk" PRIMARY KEY("wallet","day")
);
