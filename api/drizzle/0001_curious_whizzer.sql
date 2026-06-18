CREATE TABLE "user_watched_wallets" (
	"user_id" text NOT NULL,
	"wallet_address" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"color" text,
	"created_at" bigint NOT NULL,
	CONSTRAINT "user_watched_wallets_user_id_wallet_address_pk" PRIMARY KEY("user_id","wallet_address")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"email_display" text NOT NULL,
	"password_hash" text NOT NULL,
	"is_owner" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE INDEX "idx_uww_wallet" ON "user_watched_wallets" USING btree ("wallet_address");