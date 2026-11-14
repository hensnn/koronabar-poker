ALTER TABLE "chat_messages" ADD COLUMN "thread_id" bigint;--> statement-breakpoint
CREATE INDEX "chat_messages_thread_idx" ON "chat_messages" USING btree ("thread_id","id");--> statement-breakpoint
-- Existing replies join their threads: every reply climbs through "reply_to" up to the message that answers nothing
-- (the question) and takes its id. A reply whose question is gone (old history was cleaned) stays a standalone message.
WITH RECURSIVE "chain"("start", "cur") AS (
	SELECT "id", "reply_to" FROM "chat_messages" WHERE "reply_to" IS NOT NULL
	UNION ALL
	SELECT c."start", p."reply_to" FROM "chain" c JOIN "chat_messages" p ON p."id" = c."cur" WHERE p."reply_to" IS NOT NULL
)
UPDATE "chat_messages" m SET "thread_id" = c."cur"
FROM "chain" c JOIN "chat_messages" r ON r."id" = c."cur" AND r."reply_to" IS NULL
WHERE m."id" = c."start";
