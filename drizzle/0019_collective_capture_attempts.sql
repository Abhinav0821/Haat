ALTER TABLE "collective_plans" ADD COLUMN "capture_attempt_id" text;--> statement-breakpoint
ALTER TABLE "collective_plans" ADD COLUMN "capture_lease_until" timestamp with time zone;