CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"order_id" text,
	"product_id" text,
	"parent_id" text,
	"direction" text NOT NULL,
	"channel" text DEFAULT 'web' NOT NULL,
	"buyer_email" text,
	"original_text" text NOT NULL,
	"original_language" text,
	"translated_text" text,
	"translated_language" text,
	"shield" jsonb,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;