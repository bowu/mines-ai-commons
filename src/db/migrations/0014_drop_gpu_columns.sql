ALTER TABLE "agents"
  DROP COLUMN IF EXISTS "gpu_type",
  DROP COLUMN IF EXISTS "gpu_active",
  DROP COLUMN IF EXISTS "desired_gpu_active",
  DROP COLUMN IF EXISTS "desired_gpu_type";
