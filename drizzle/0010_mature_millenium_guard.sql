CREATE TABLE "email_verification_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(254) NOT NULL,
	"code" varchar(10) NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "email_verification_email_idx" ON "email_verification_codes" USING btree ("email");--> statement-breakpoint
CREATE INDEX "email_verification_expires_idx" ON "email_verification_codes" USING btree ("expires_at");