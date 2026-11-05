ALTER TABLE "orders" ADD COLUMN "buyer_name" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shipping_address" jsonb;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "captured_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "seller_translation" text;