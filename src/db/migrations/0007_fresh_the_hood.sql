ALTER TABLE "agents" ADD COLUMN "machine_type" text DEFAULT 'e2-medium';--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "gpu_type" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "gpu_active" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "vm_status" text DEFAULT 'stopped';--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "vm_name" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "vm_ip" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "vm_zone" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "data_disk_name" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "vm_token_generation" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "last_activity_at" timestamp DEFAULT now();--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "vm_provision_error" text;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_vm_status_check" CHECK ("vm_status" IN ('creating','running','starting','stopping','stopped','upgrading','deleting','error'));--> statement-breakpoint
CREATE INDEX "agents_last_activity_at_active_idx" ON "agents" ("last_activity_at") WHERE "vm_status" IN ('running', 'upgrading');
