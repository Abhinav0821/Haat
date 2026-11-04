ALTER TABLE "products" ADD COLUMN "publish_key" text;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_publish_key_unique" UNIQUE("publish_key");