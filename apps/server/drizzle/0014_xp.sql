CREATE TABLE "player_progress" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"xp" bigint DEFAULT 0 NOT NULL,
	"level" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tournament_eliminations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tournament_eliminations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tournament_id" text NOT NULL,
	"victim_id" uuid NOT NULL,
	"place" integer NOT NULL,
	"killers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "xp_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "xp_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" uuid NOT NULL,
	"source" text NOT NULL,
	"ref" text NOT NULL,
	"day" text NOT NULL,
	"amount" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "player_progress" ADD CONSTRAINT "player_progress_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_eliminations" ADD CONSTRAINT "tournament_eliminations_victim_id_users_id_fk" FOREIGN KEY ("victim_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "xp_events" ADD CONSTRAINT "xp_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tournament_eliminations_uq" ON "tournament_eliminations" USING btree ("tournament_id","victim_id","place");--> statement-breakpoint
CREATE UNIQUE INDEX "xp_events_uq" ON "xp_events" USING btree ("user_id","source","ref");--> statement-breakpoint
CREATE INDEX "xp_events_user_day_idx" ON "xp_events" USING btree ("user_id","day");