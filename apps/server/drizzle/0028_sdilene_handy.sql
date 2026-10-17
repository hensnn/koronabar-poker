CREATE TABLE "hand_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shared_id" uuid NOT NULL,
	"user_id" uuid,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "hand_reactions" (
	"shared_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"emoji" text NOT NULL,
	CONSTRAINT "hand_reactions_shared_id_user_id_emoji_pk" PRIMARY KEY("shared_id","user_id","emoji")
);
--> statement-breakpoint
CREATE TABLE "shared_hands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hand_id" text NOT NULL,
	"shared_by" uuid,
	"revealed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"poll_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "evenings" ADD COLUMN "hand_vote" jsonb;--> statement-breakpoint
ALTER TABLE "hand_comments" ADD CONSTRAINT "hand_comments_shared_id_shared_hands_id_fk" FOREIGN KEY ("shared_id") REFERENCES "public"."shared_hands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hand_comments" ADD CONSTRAINT "hand_comments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hand_reactions" ADD CONSTRAINT "hand_reactions_shared_id_shared_hands_id_fk" FOREIGN KEY ("shared_id") REFERENCES "public"."shared_hands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hand_reactions" ADD CONSTRAINT "hand_reactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_hands" ADD CONSTRAINT "shared_hands_shared_by_users_id_fk" FOREIGN KEY ("shared_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hand_comments_shared_idx" ON "hand_comments" USING btree ("shared_id");--> statement-breakpoint
CREATE INDEX "shared_hands_hand_idx" ON "shared_hands" USING btree ("hand_id");