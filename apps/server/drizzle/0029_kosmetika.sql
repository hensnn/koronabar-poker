CREATE TABLE "cosmetic_items" (
	"key" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"look" jsonb NOT NULL,
	"acquire" jsonb NOT NULL,
	"price" integer,
	"available_from" timestamp with time zone,
	"available_until" timestamp with time zone,
	"enabled" boolean DEFAULT true NOT NULL,
	"builtin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_cosmetics" (
	"user_id" uuid NOT NULL,
	"item_key" text NOT NULL,
	"source" text NOT NULL,
	"paid" integer DEFAULT 0 NOT NULL,
	"equipped" boolean DEFAULT false NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_cosmetics_user_id_item_key_pk" PRIMARY KEY("user_id","item_key")
);
--> statement-breakpoint
ALTER TABLE "player_cosmetics" ADD CONSTRAINT "player_cosmetics_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_cosmetics" ADD CONSTRAINT "player_cosmetics_item_key_cosmetic_items_key_fk" FOREIGN KEY ("item_key") REFERENCES "public"."cosmetic_items"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "player_cosmetics_user_idx" ON "player_cosmetics" USING btree ("user_id");