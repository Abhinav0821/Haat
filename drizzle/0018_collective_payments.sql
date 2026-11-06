CREATE TABLE "maker_payments" (
	"id" text PRIMARY KEY NOT NULL,
	"share_id" text NOT NULL,
	"collective_id" text NOT NULL,
	"member_id" text NOT NULL,
	"amount_paise" integer NOT NULL,
	"method" text NOT NULL,
	"reference" text NOT NULL,
	"reported_by" text NOT NULL,
	"reported_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"responded_at" timestamp with time zone,
	"responded_via" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maker_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"collective_id" text NOT NULL,
	"order_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"member_id" text NOT NULL,
	"part_id" text NOT NULL,
	"part_terms_hash" text NOT NULL,
	"owed_paise" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "store_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "collective_plan_id" text;--> statement-breakpoint
ALTER TABLE "maker_payments" ADD CONSTRAINT "maker_payments_share_id_maker_shares_id_fk" FOREIGN KEY ("share_id") REFERENCES "public"."maker_shares"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maker_payments" ADD CONSTRAINT "maker_payments_collective_id_collectives_id_fk" FOREIGN KEY ("collective_id") REFERENCES "public"."collectives"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maker_payments" ADD CONSTRAINT "maker_payments_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maker_shares" ADD CONSTRAINT "maker_shares_collective_id_collectives_id_fk" FOREIGN KEY ("collective_id") REFERENCES "public"."collectives"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maker_shares" ADD CONSTRAINT "maker_shares_order_id_collective_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."collective_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maker_shares" ADD CONSTRAINT "maker_shares_plan_id_collective_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."collective_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maker_shares" ADD CONSTRAINT "maker_shares_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maker_shares" ADD CONSTRAINT "maker_shares_part_id_member_parts_id_fk" FOREIGN KEY ("part_id") REFERENCES "public"."member_parts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "maker_payments_share" ON "maker_payments" USING btree ("share_id");--> statement-breakpoint
CREATE INDEX "maker_payments_collective_ref" ON "maker_payments" USING btree ("collective_id","method","reference");--> statement-breakpoint
CREATE UNIQUE INDEX "maker_shares_plan_member" ON "maker_shares" USING btree ("plan_id","member_id");--> statement-breakpoint
CREATE INDEX "maker_shares_member" ON "maker_shares" USING btree ("member_id");