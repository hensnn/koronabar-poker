CREATE TABLE "bet_stakes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bet_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"side" text NOT NULL,
	"amount" bigint NOT NULL,
	"status" text DEFAULT 'held' NOT NULL,
	"payout" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tournament_id" text NOT NULL,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"title" text NOT NULL,
	"creator_id" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"close_rule" text DEFAULT 'start' NOT NULL,
	"fee_percent" integer DEFAULT 0 NOT NULL,
	"outcome" text,
	"proposed_outcome" text,
	"proposed_by" uuid,
	"proposed_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "head_bounties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tournament_id" text NOT NULL,
	"target_id" uuid NOT NULL,
	"poster_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"paid_to" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "bet_stakes" ADD CONSTRAINT "bet_stakes_bet_id_bets_id_fk" FOREIGN KEY ("bet_id") REFERENCES "public"."bets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bet_stakes" ADD CONSTRAINT "bet_stakes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bets" ADD CONSTRAINT "bets_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "head_bounties" ADD CONSTRAINT "head_bounties_target_id_users_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "head_bounties" ADD CONSTRAINT "head_bounties_poster_id_users_id_fk" FOREIGN KEY ("poster_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bet_stakes_bet_idx" ON "bet_stakes" USING btree ("bet_id");--> statement-breakpoint
CREATE INDEX "bet_stakes_user_idx" ON "bet_stakes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "bets_tournament_idx" ON "bets" USING btree ("tournament_id");--> statement-breakpoint
CREATE INDEX "bets_status_idx" ON "bets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "head_bounties_tournament_idx" ON "head_bounties" USING btree ("tournament_id","status");