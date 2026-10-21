ALTER TABLE "blocks" ADD COLUMN "id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "blocks" ADD COLUMN "alias" varchar(40);--> statement-breakpoint
ALTER TABLE "room_messages" ADD COLUMN "seq" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "room_messages" ADD COLUMN "client_msg_id" varchar(64) NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "room_messages_room_seq_uq" ON "room_messages" USING btree ("room_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "room_messages_dedupe_uq" ON "room_messages" USING btree ("room_id","user_id","client_msg_id");--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_id_unique" UNIQUE("id");