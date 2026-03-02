import { execFile } from "node:child_process";
import { access, readdir, stat } from "node:fs/promises";
import path from "node:path";

const MAX_TAR_BUFFER_BYTES = 20 * 1024 * 1024;

let cachedBundle: Buffer | null = null;
let cachedFingerprint = "";

async function collectFilesRecursively(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFilesRecursively(fullPath)));
      continue;
    }
    if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

async function runtimeFingerprint(sandboxDir: string): Promise<string> {
  const packagePath = path.join(sandboxDir, "package.json");
  const distDir = path.join(sandboxDir, "dist");
  const distFiles = await collectFilesRecursively(distDir);
  const trackedFiles = [packagePath, ...distFiles].sort();
  const parts = await Promise.all(
    trackedFiles.map(async (file) => {
      const info = await stat(file);
      return `${file}:${info.mtimeMs}:${info.size}`;
    }),
  );
  return parts.join("|");
}

async function buildBundle(sandboxDir: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      "tar",
      ["-czf", "-", "-C", sandboxDir, "dist", "package.json"],
      { encoding: "buffer", maxBuffer: MAX_TAR_BUFFER_BYTES },
      (error, stdout, stderr) => {
        if (error) {
          const detail =
            typeof stderr === "string" ? stderr : stderr?.toString("utf8");
          reject(
            new Error(
              `Failed to create sandbox runtime bundle: ${detail || error.message}`,
            ),
          );
          return;
        }
        resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
      },
    );
  });
}

export async function getSandboxRuntimeBundle(): Promise<Buffer> {
  const sandboxDir = path.resolve(process.cwd(), "sandbox");
  const packagePath = path.join(sandboxDir, "package.json");
  const distDir = path.join(sandboxDir, "dist");

  await access(packagePath);
  await access(distDir);

  const fingerprint = await runtimeFingerprint(sandboxDir);
  if (cachedBundle && cachedFingerprint === fingerprint) {
    return cachedBundle;
  }

  const bundle = await buildBundle(sandboxDir);
  cachedBundle = bundle;
  cachedFingerprint = fingerprint;
  return bundle;
}
