-- Cut over to wallet-address identity. Legacy email/password accounts are discarded (full cutover, per
-- the auth spec); the expensive on-chain data (positions, wallet_flows, dlmm_*) is keyed by wallet
-- ADDRESS, not by user id, so it all survives — re-adding a wallet resumes ingest from its cursor.
DELETE FROM "user_watched_wallets";--> statement-breakpoint
DELETE FROM "users";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "email";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "email_display";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "address" text NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "token_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_address_unique" UNIQUE("address");--> statement-breakpoint
CREATE TABLE "wallet_whitelist" (
	"address" text PRIMARY KEY NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"added_by" text DEFAULT '' NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_nonces" (
	"nonce" text PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_auth_nonces_address" ON "auth_nonces" USING btree ("address");
