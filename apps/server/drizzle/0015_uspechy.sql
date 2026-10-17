CREATE TABLE "achievements" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"icon" text NOT NULL,
	"description" text NOT NULL,
	"condition" jsonb NOT NULL,
	"xp" integer DEFAULT 0 NOT NULL,
	"builtin" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_achievements" (
	"user_id" uuid NOT NULL,
	"key" text NOT NULL,
	"earned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_achievements_user_id_key_pk" PRIMARY KEY("user_id","key")
);
--> statement-breakpoint
ALTER TABLE "player_achievements" ADD CONSTRAINT "player_achievements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_achievements" ADD CONSTRAINT "player_achievements_key_achievements_key_fk" FOREIGN KEY ("key") REFERENCES "public"."achievements"("key") ON DELETE cascade ON UPDATE no action;