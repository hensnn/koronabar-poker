CREATE TABLE "game_results" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "game_results_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"user_id" uuid NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"place" integer NOT NULL,
	"field" integer NOT NULL,
	"spent" bigint NOT NULL,
	"payout" bigint NOT NULL,
	"bounty" bigint DEFAULT 0 NOT NULL,
	"rebuys" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hand_players" (
	"hand_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"seat" integer NOT NULL,
	"kind" text NOT NULL,
	"played_at" timestamp with time zone NOT NULL,
	"start_stack" bigint NOT NULL,
	"invested" bigint NOT NULL,
	"won" bigint NOT NULL,
	"hole" jsonb,
	"revealed" boolean DEFAULT false NOT NULL,
	"vpip" boolean DEFAULT false NOT NULL,
	"pfr" boolean DEFAULT false NOT NULL,
	"three_bet_chance" boolean DEFAULT false NOT NULL,
	"three_bet" boolean DEFAULT false NOT NULL,
	"saw_flop" boolean DEFAULT false NOT NULL,
	"showdown" boolean DEFAULT false NOT NULL,
	"won_showdown" boolean DEFAULT false NOT NULL,
	"aggressive" integer DEFAULT 0 NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"hand_score" integer,
	"hand_key" text,
	CONSTRAINT "hand_players_hand_id_user_id_pk" PRIMARY KEY("hand_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "hands" (
	"id" text PRIMARY KEY NOT NULL,
	"table_id" text NOT NULL,
	"kind" text NOT NULL,
	"tournament_id" text,
	"hand_number" integer NOT NULL,
	"played_at" timestamp with time zone NOT NULL,
	"button_seat" integer,
	"board" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pot" bigint NOT NULL,
	"rake" bigint DEFAULT 0 NOT NULL,
	"showdown" boolean DEFAULT false NOT NULL,
	"runs" integer DEFAULT 1 NOT NULL,
	"purged" boolean DEFAULT false NOT NULL,
	"chips_per_unit" integer DEFAULT 1 NOT NULL,
	"blinds" jsonb NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seasons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "game_results" ADD CONSTRAINT "game_results_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hand_players" ADD CONSTRAINT "hand_players_hand_id_hands_id_fk" FOREIGN KEY ("hand_id") REFERENCES "public"."hands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hand_players" ADD CONSTRAINT "hand_players_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "game_results_uq" ON "game_results" USING btree ("kind","ref","user_id");--> statement-breakpoint
CREATE INDEX "game_results_user_idx" ON "game_results" USING btree ("user_id","finished_at");--> statement-breakpoint
CREATE INDEX "hand_players_user_idx" ON "hand_players" USING btree ("user_id","played_at");--> statement-breakpoint
CREATE INDEX "hands_played_idx" ON "hands" USING btree ("played_at");--> statement-breakpoint
CREATE INDEX "hands_table_idx" ON "hands" USING btree ("table_id","played_at");