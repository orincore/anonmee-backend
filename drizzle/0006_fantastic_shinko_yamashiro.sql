DROP INDEX "groups_open_topic_idx";--> statement-breakpoint
DROP INDEX "groups_open_created_idx";--> statement-breakpoint
DROP INDEX "users_created_idx";--> statement-breakpoint
CREATE INDEX "groups_open_topic_idx" ON "groups" USING btree ("topic","created_at","id") WHERE "groups"."closed_at" is null;--> statement-breakpoint
CREATE INDEX "groups_open_created_idx" ON "groups" USING btree ("created_at","id") WHERE "groups"."closed_at" is null;--> statement-breakpoint
CREATE INDEX "users_created_idx" ON "users" USING btree ("created_at","id");