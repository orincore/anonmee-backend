CREATE TABLE "chat_review_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"user_id" uuid NOT NULL,
	"alias" varchar(40) NOT NULL,
	"text" varchar(2000) NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_review_messages" ADD CONSTRAINT "chat_review_messages_chat_id_matches_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_review_chat_seq_uq" ON "chat_review_messages" USING btree ("chat_id","seq");--> statement-breakpoint
CREATE INDEX "chat_review_created_idx" ON "chat_review_messages" USING btree ("created_at");