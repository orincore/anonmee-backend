CREATE TABLE "user_activity_daily" (
	"user_id" uuid NOT NULL,
	"day" date NOT NULL,
	"screen_time_seconds" integer DEFAULT 0 NOT NULL,
	"messages_sent" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_activity_daily_user_id_day_pk" PRIMARY KEY("user_id","day")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "device_fingerprint" varchar(64);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "device_id" varchar(64);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "screen_time_seconds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_activity_daily" ADD CONSTRAINT "user_activity_daily_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_user_activity_daily_day" ON "user_activity_daily" USING btree ("day");--> statement-breakpoint
CREATE INDEX "users_device_fingerprint_idx" ON "users" USING btree ("device_fingerprint");--> statement-breakpoint
CREATE INDEX "users_device_id_idx" ON "users" USING btree ("device_id");