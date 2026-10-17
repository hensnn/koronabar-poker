CREATE TABLE "rating_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "rating_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"ref" text NOT NULL,
	"kind" text DEFAULT 'game' NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"mu_before" double precision NOT NULL,
	"sigma_before" double precision NOT NULL,
	"mu_after" double precision NOT NULL,
	"sigma_after" double precision NOT NULL,
	"display_before" integer NOT NULL,
	"display_after" integer NOT NULL,
	"breakdown" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rating_state" (
	"user_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"mu" double precision NOT NULL,
	"sigma" double precision NOT NULL,
	"games" integer DEFAULT 0 NOT NULL,
	"peak" integer NOT NULL,
	"last_played_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rating_state_user_id_scope_pk" PRIMARY KEY("user_id","scope")
);
--> statement-breakpoint
ALTER TABLE "rating_events" ADD CONSTRAINT "rating_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rating_state" ADD CONSTRAINT "rating_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "rating_events_uq" ON "rating_events" USING btree ("user_id","scope","ref");--> statement-breakpoint
CREATE INDEX "rating_events_user_idx" ON "rating_events" USING btree ("user_id","scope","at");