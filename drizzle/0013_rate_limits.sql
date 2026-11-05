CREATE TABLE "rate_hits" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "rate_hits_key_at" ON "rate_hits" USING btree ("key","at");