CREATE INDEX "matches_user_a_idx" ON "matches" USING btree ("user_a_id","created_at","id");--> statement-breakpoint
CREATE INDEX "matches_user_b_idx" ON "matches" USING btree ("user_b_id","created_at","id");--> statement-breakpoint
CREATE INDEX "room_messages_user_idx" ON "room_messages" USING btree ("user_id","created_at","id");