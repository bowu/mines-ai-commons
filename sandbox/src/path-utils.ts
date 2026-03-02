import path from "node:path";

export function jailPath(workspaceRoot: string, inputPath: string): string {
  const resolved = path.resolve(workspaceRoot, inputPath);
  if (resolved !== workspaceRoot && !resolved.startsWith(`${workspaceRoot}/`)) {
    throw new Error("Path outside workspace");
  }
  return resolved;
}

export function sanitizeRelativePath(inputPath: string): string {
  const normalized = path.normalize(inputPath || ".");
  if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
    throw new Error("Invalid path");
  }
  return normalized;
}
