CREATE TABLE "collective_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"collective_id" text NOT NULL,
	"channel" text DEFAULT 'web' NOT NULL,
	"buyer_name" text,
	"buyer_email" text,
	"buyer_text" text NOT NULL,
	"spec" jsonb NOT NULL,
	"excluded_member_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_evaluation" jsonb,
	"status" text DEFAULT 'new' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collective_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"collective_id" text NOT NULL,
	"version" integer NOT NULL,
	"superseded_by_id" text,
	"choice" text NOT NULL,
	"facts" jsonb NOT NULL,
	"request" jsonb NOT NULL,
	"plan" jsonb NOT NULL,
	"optimality" jsonb,
	"certified" integer NOT NULL,
	"terms" jsonb NOT NULL,
	"terms_hash" text NOT NULL,
	"status" text NOT NULL,
	"status_note" text,
	"buyer_approved_hash" text,
	"buyer_approved_at" timestamp with time zone,
	"hold_until" timestamp with time zone,
	"reserved" jsonb,
	"payment_ref" text,
	"paying_since" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collectives" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"coordinator_name" text NOT NULL,
	"settings" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collectives_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "member_parts" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"member_id" text NOT NULL,
	"version" integer NOT NULL,
	"superseded_by_id" text,
	"terms" jsonb NOT NULL,
	"terms_hash" text NOT NULL,
	"status" text NOT NULL,
	"responded_hash" text,
	"responded_at" timestamp with time zone,
	"responded_via" text,
	"response_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "members" (
	"id" text PRIMARY KEY NOT NULL,
	"collective_id" text NOT NULL,
	"name" text NOT NULL,
	"name_hi" text,
	"link_hash" text NOT NULL,
	"facts" jsonb NOT NULL,
	"active" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "members_link_hash_unique" UNIQUE("link_hash")
);
--> statement-breakpoint
ALTER TABLE "collective_orders" ADD CONSTRAINT "collective_orders_collective_id_collectives_id_fk" FOREIGN KEY ("collective_id") REFERENCES "public"."collectives"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collective_plans" ADD CONSTRAINT "collective_plans_order_id_collective_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."collective_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collective_plans" ADD CONSTRAINT "collective_plans_collective_id_collectives_id_fk" FOREIGN KEY ("collective_id") REFERENCES "public"."collectives"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_parts" ADD CONSTRAINT "member_parts_order_id_collective_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."collective_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_parts" ADD CONSTRAINT "member_parts_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_collective_id_collectives_id_fk" FOREIGN KEY ("collective_id") REFERENCES "public"."collectives"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "collective_plans_order_version" ON "collective_plans" USING btree ("order_id","version");--> statement-breakpoint
CREATE INDEX "collective_plans_collective_status" ON "collective_plans" USING btree ("collective_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "member_parts_order_member_version" ON "member_parts" USING btree ("order_id","member_id","version");