CREATE TABLE "media" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"kind" text NOT NULL,
	"media_type" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "voice_note_id" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "seller_transcript" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "seller_language" text;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;