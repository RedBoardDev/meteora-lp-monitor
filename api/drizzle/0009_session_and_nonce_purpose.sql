ALTER TABLE "auth_nonces" ADD COLUMN "purpose" text DEFAULT 'register' NOT NULL;--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"jti" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_auth_sessions_user" ON "auth_sessions" USING btree ("user_id");
