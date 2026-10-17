ALTER TABLE "game_results" ADD COLUMN "target_minutes" integer;--> statement-breakpoint
ALTER TABLE "game_results" ADD COLUMN "rated" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "hand_players" ADD COLUMN "all_in_equity" double precision;