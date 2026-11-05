ALTER TABLE "agent_actions" ADD COLUMN "order_id" text;--> statement-breakpoint
ALTER TABLE "agent_actions" ADD COLUMN "message_id" text;--> statement-breakpoint
ALTER TABLE "agent_actions" ADD COLUMN "summary_hi" text;--> statement-breakpoint
ALTER TABLE "agent_actions" ADD COLUMN "summary_en" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "intent" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "refunded_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "tracking_number" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "tracking_carrier" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "tracking_added_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;