CREATE TABLE "agreements" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"request_id" text NOT NULL,
	"version" integer NOT NULL,
	"superseded_by_id" text,
	"terms" jsonb NOT NULL,
	"terms_hash" text NOT NULL,
	"status" text NOT NULL,
	"buyer_approved_hash" text,
	"buyer_approved_at" timestamp with time zone,
	"seller_approved_hash" text,
	"seller_approved_at" timestamp with time zone,
	"hold_until" timestamp with time zone,
	"order_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"channel" text DEFAULT 'web' NOT NULL,
	"buyer_name" text,
	"buyer_email" text,
	"buyer_text" text NOT NULL,
	"spec" jsonb NOT NULL,
	"summary_hi" text,
	"seller_said" text,
	"draft_options" jsonb,
	"options" jsonb,
	"counter" jsonb,
	"status" text DEFAULT 'new' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "agreement_id" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "terms_hash" text;--> statement-breakpoint
ALTER TABLE "agreements" ADD CONSTRAINT "agreements_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreements" ADD CONSTRAINT "agreements_request_id_custom_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."custom_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_requests" ADD CONSTRAINT "custom_requests_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;