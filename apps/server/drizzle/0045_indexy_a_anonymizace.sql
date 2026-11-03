ALTER TABLE "game_results" DROP CONSTRAINT "game_results_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "hand_players" DROP CONSTRAINT "hand_players_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "rating_events" DROP CONSTRAINT "rating_events_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "rating_state" DROP CONSTRAINT "rating_state_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "tournament_eliminations" DROP CONSTRAINT "tournament_eliminations_victim_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "xp_events" DROP CONSTRAINT "xp_events_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "game_results" ADD CONSTRAINT "game_results_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hand_players" ADD CONSTRAINT "hand_players_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rating_events" ADD CONSTRAINT "rating_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rating_state" ADD CONSTRAINT "rating_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_eliminations" ADD CONSTRAINT "tournament_eliminations_victim_id_users_id_fk" FOREIGN KEY ("victim_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "xp_events" ADD CONSTRAINT "xp_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "game_results_kind_idx" ON "game_results" USING btree ("kind","finished_at");--> statement-breakpoint
CREATE INDEX "hand_players_kind_idx" ON "hand_players" USING btree ("kind","played_at");--> statement-breakpoint
CREATE INDEX "hands_tournament_idx" ON "hands" USING btree ("tournament_id");--> statement-breakpoint
CREATE INDEX "tournaments_sched_idx" ON "tournaments" USING btree ("id") WHERE "tournaments"."sched" is not null;