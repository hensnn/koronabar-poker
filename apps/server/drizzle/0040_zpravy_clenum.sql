CREATE TABLE "broadcast_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sender_id" uuid,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"link" text,
	"channels" jsonb NOT NULL,
	"audience" jsonb NOT NULL,
	"recipients" integer NOT NULL,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "broadcast_messages" ADD CONSTRAINT "broadcast_messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "broadcast_messages_created_idx" ON "broadcast_messages" USING btree ("created_at");