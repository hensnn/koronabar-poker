CREATE TABLE "note_labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personal_limits" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"current" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"pending" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"break_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_notes" (
	"owner_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"label_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_notes_owner_id_target_id_pk" PRIMARY KEY("owner_id","target_id")
);
--> statement-breakpoint
ALTER TABLE "note_labels" ADD CONSTRAINT "note_labels_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_limits" ADD CONSTRAINT "personal_limits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_notes" ADD CONSTRAINT "player_notes_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_notes" ADD CONSTRAINT "player_notes_target_id_users_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_notes" ADD CONSTRAINT "player_notes_label_id_note_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."note_labels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "note_labels_owner_idx" ON "note_labels" USING btree ("owner_id");