CREATE TABLE "sound_emotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid,
	"name" text NOT NULL,
	"shortcut" text NOT NULL,
	"emoji" text DEFAULT '🔊' NOT NULL,
	"category" text DEFAULT 'ostatni' NOT NULL,
	"status" text DEFAULT 'private' NOT NULL,
	"mime" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"size_bytes" integer NOT NULL,
	"builtin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sound_favorites" (
	"user_id" uuid NOT NULL,
	"sound_id" uuid NOT NULL,
	"favorite" boolean DEFAULT false NOT NULL,
	"last_used_at" timestamp with time zone,
	"uses" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "sound_favorites_user_id_sound_id_pk" PRIMARY KEY("user_id","sound_id")
);
--> statement-breakpoint
CREATE TABLE "sound_mutes" (
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"target" text NOT NULL,
	CONSTRAINT "sound_mutes_user_id_kind_target_pk" PRIMARY KEY("user_id","kind","target")
);
--> statement-breakpoint
ALTER TABLE "sound_emotes" ADD CONSTRAINT "sound_emotes_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sound_favorites" ADD CONSTRAINT "sound_favorites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sound_favorites" ADD CONSTRAINT "sound_favorites_sound_id_sound_emotes_id_fk" FOREIGN KEY ("sound_id") REFERENCES "public"."sound_emotes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sound_mutes" ADD CONSTRAINT "sound_mutes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sound_emotes_shortcut_uq" ON "sound_emotes" USING btree ("shortcut");--> statement-breakpoint
CREATE INDEX "sound_emotes_owner_idx" ON "sound_emotes" USING btree ("owner_id");