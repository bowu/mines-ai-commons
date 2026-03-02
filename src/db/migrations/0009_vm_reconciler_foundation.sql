ALTER TABLE "agents" ADD COLUMN "desired_vm_state" text DEFAULT 'stopped' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "observed_vm_state" text DEFAULT 'stopped' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "last_reconciled_at" timestamp;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "last_provision_error" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "last_provision_error_at" timestamp;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "reconcile_attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "next_reconcile_at" timestamp DEFAULT now();--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "desired_gpu_active" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "desired_gpu_type" text;--> statement-breakpoint

UPDATE "agents"
SET
  "desired_vm_state" = CASE
    WHEN "vm_status" = 'running' THEN 'running'
    WHEN "vm_status" IN ('starting', 'creating', 'upgrading') THEN 'running'
    WHEN "vm_status" IN ('stopping', 'deleting') THEN 'stopped'
    WHEN "vm_status" = 'error' THEN 'stopped'
    ELSE 'stopped'
  END,
  "observed_vm_state" = CASE
    WHEN "vm_status" = 'running' THEN 'running'
    WHEN "vm_status" IN ('starting', 'creating', 'upgrading') THEN 'stopped'
    WHEN "vm_status" = 'stopped' THEN 'stopped'
    WHEN "vm_status" IN ('stopping', 'deleting') THEN 'running'
    WHEN "vm_status" = 'error' THEN 'stopped'
    ELSE 'stopped'
  END,
  "desired_gpu_active" = COALESCE("gpu_active", false),
  "desired_gpu_type" = "gpu_type",
  "last_provision_error" = "vm_provision_error";--> statement-breakpoint

CREATE INDEX "agents_reconcile_idx"
  ON "agents" ("next_reconcile_at")
  WHERE "deleted_at" IS NULL;--> statement-breakpoint

CREATE INDEX "agents_deleted_gc_idx"
  ON "agents" ("deleted_at")
  WHERE "deleted_at" IS NOT NULL;
