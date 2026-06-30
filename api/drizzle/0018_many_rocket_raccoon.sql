ALTER TABLE "copy_journal" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "copy_journal" ADD COLUMN "wallet" text;--> statement-breakpoint
ALTER TABLE "copy_journal" ADD COLUMN "correlation_id" text;--> statement-breakpoint
ALTER TABLE "copy_journal" ADD COLUMN "event_ts" bigint;--> statement-breakpoint
ALTER TABLE "copy_journal" ADD COLUMN "code" text;--> statement-breakpoint
ALTER TABLE "copy_journal" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "copy_journal" ADD COLUMN "audience" text;--> statement-breakpoint
ALTER TABLE "copy_journal" ADD COLUMN "pinned" boolean;--> statement-breakpoint
ALTER TABLE "copy_journal" ADD COLUMN "delivered_at" bigint;--> statement-breakpoint
CREATE INDEX "idx_copy_journal_wallet_ts" ON "copy_journal" USING btree ("wallet","ts");--> statement-breakpoint
CREATE INDEX "idx_copy_journal_user_ts" ON "copy_journal" USING btree ("user_id","ts");--> statement-breakpoint
CREATE INDEX "idx_copy_journal_code" ON "copy_journal" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_copy_journal_wallet_corr_code" ON "copy_journal" USING btree ("wallet","correlation_id","code");