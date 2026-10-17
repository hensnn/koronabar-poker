CREATE TABLE "evening_games" (
	"evening_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evening_games_evening_id_kind_ref_pk" PRIMARY KEY("evening_id","kind","ref")
);
--> statement-breakpoint
CREATE TABLE "evenings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"touched_at" timestamp with time zone NOT NULL,
	"auto" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"summary" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "evening_games" ADD CONSTRAINT "evening_games_evening_id_evenings_id_fk" FOREIGN KEY ("evening_id") REFERENCES "public"."evenings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evenings" ADD CONSTRAINT "evenings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evening_games_ref_idx" ON "evening_games" USING btree ("kind","ref");