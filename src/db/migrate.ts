import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { config } from "../config.js";

const { Pool } = pg;

const runtimeMigrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "migrations",
);
const sourceMigrationsFolder = path.resolve(process.cwd(), "src/db/migrations");

export const MIGRATIONS_FOLDER = existsSync(sourceMigrationsFolder)
  ? sourceMigrationsFolder
  : runtimeMigrationsFolder;

export async function runMigrations(connectionString: string): Promise<void> {
  const trimmed = connectionString.trim();
  if (!trimmed) {
    throw new Error("DATABASE_URL is required to run migrations");
  }

  const pool = new Pool({ connectionString: trimmed });
  try {
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await pool.end();
  }
}

async function runCli(): Promise<void> {
  await runMigrations(config.databaseUrl);
}

const isMainModule =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  runCli().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
