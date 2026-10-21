DROP INDEX "groups_topic_idx";--> statement-breakpoint
DROP INDEX "groups_created_idx";--> statement-breakpoint
DROP INDEX "room_messages_room_time_idx";--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "member_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "room_messages" ADD COLUMN "gender" "gender" DEFAULT 'prefer_not_to_say' NOT NULL;--> statement-breakpoint
ALTER TABLE "room_messages" ADD COLUMN "age" integer DEFAULT 18 NOT NULL;--> statement-breakpoint
CREATE INDEX "blocks_blocked_idx" ON "blocks" USING btree ("blocked_id");--> statement-breakpoint
CREATE INDEX "group_members_user_idx" ON "group_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "group_members_joined_idx" ON "group_members" USING btree ("group_id","joined_at","user_id");--> statement-breakpoint
CREATE INDEX "groups_open_topic_idx" ON "groups" USING btree ("topic","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "groups"."closed_at" is null;--> statement-breakpoint
CREATE INDEX "groups_open_created_idx" ON "groups" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "groups"."closed_at" is null;--> statement-breakpoint
CREATE INDEX "groups_tags_gin" ON "groups" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "refresh_expires_idx" ON "refresh_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "reports_reported_idx" ON "reports" USING btree ("reported_id","created_at");--> statement-breakpoint
CREATE INDEX "reports_queue_idx" ON "reports" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "room_messages_created_idx" ON "room_messages" USING btree ("created_at");--> statement-breakpoint
UPDATE "groups" g SET "member_count" = (SELECT count(*)::int FROM "group_members" m WHERE m."group_id" = g."id");
