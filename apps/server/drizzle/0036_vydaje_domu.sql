CREATE TABLE "house_expenses" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "house_expenses_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"category" text NOT NULL,
	"amount" bigint NOT NULL,
	"note" text NOT NULL,
	"tx_id" bigint,
	"created_by" uuid,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "house_expenses" ADD CONSTRAINT "house_expenses_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "house_expenses_at_idx" ON "house_expenses" USING btree ("at");