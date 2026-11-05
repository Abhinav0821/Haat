CREATE TABLE "passports" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"store_id" text NOT NULL,
	"code" text NOT NULL,
	"code_issued_at" timestamp with time zone NOT NULL,
	"proof_media_id" text,
	"status" text NOT NULL,
	"checks" jsonb,
	"signature" text,
	"payload" jsonb,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "passports_product_id_unique" UNIQUE("product_id")
);
--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "dhash" text;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "sha256" text;--> statement-breakpoint
ALTER TABLE "passports" ADD CONSTRAINT "passports_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passports" ADD CONSTRAINT "passports_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;