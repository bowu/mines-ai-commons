import { config } from "../../config.js";

const RESEARCH_GPU_MACHINE_TYPES = [
  "a2-highgpu-1g",
  "a2-highgpu-2g",
  "a2-highgpu-4g",
  "a2-highgpu-8g",
] as const;

const BUILTIN_GPU_MACHINE_TYPE_SET = new Set<string>(
  RESEARCH_GPU_MACHINE_TYPES,
);

export function getSupportedGpuMachineTypes(): string[] {
  const values: string[] = [...RESEARCH_GPU_MACHINE_TYPES];
  if (config.gceGpuMachineType) {
    values.push(config.gceGpuMachineType);
  }
  return Array.from(new Set(values));
}

export function getSupportedAgentMachineTypes(): string[] {
  return Array.from(
    new Set([config.gceMachineType, ...getSupportedGpuMachineTypes()]),
  );
}

export function isSupportedAgentMachineType(machineType: string): boolean {
  return getSupportedAgentMachineTypes().includes(machineType);
}

export function isGpuMachineType(machineType: string): boolean {
  return getSupportedGpuMachineTypes().includes(machineType);
}

export function usesBuiltinGpuProfile(machineType: string): boolean {
  return BUILTIN_GPU_MACHINE_TYPE_SET.has(machineType);
}

export function desiredAcceleratorTypeForMachineType(
  machineType: string,
): string | null {
  // Accelerator-optimized machine families define GPU profile in the machine
  // type itself; do not attach guestAccelerators explicitly.
  if (usesBuiltinGpuProfile(machineType)) {
    return null;
  }

  // Backward-compatible path for legacy explicit GPU machine types.
  if (machineType === config.gceGpuMachineType) {
    return config.gceGpuType || null;
  }

  return null;
}
