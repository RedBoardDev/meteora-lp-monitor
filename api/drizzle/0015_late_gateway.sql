CREATE TABLE "copy_positions" (
	"leader_position" text PRIMARY KEY NOT NULL,
	"our_position" text NOT NULL,
	"pool" text NOT NULL,
	"non_sol_symbol" text,
	"size_sol" double precision NOT NULL,
	"lower_bin" integer NOT NULL,
	"upper_bin" integer NOT NULL,
	"status" text NOT NULL,
	"opened_at" bigint NOT NULL,
	"closed_at" bigint
);
