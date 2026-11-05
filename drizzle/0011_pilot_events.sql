CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text,
	"name" text NOT NULL,
	"props" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
