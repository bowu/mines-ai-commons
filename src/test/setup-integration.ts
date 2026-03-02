import pg from "pg";

const { Pool } = pg;

const defaultIntegrationDatabaseUrl =
  "postgresql://mines_ai:mines_ai_password@localhost:5435/mines_ai_integration";

function getDatabaseName(connectionString: string): string {
  const url = new URL(connectionString);
  const dbName = url.pathname.replace(/^\//, "");
  if (!dbName) {
    throw new Error("Integration database URL must include a database name");
  }
  if (!/^[A-Za-z0-9_]+$/.test(dbName)) {
    throw new Error(`Unsafe integration database name: ${dbName}`);
  }
  return dbName;
}

export default async function setupIntegration() {
  const integrationDatabaseUrl =
    process.env.INTEGRATION_DATABASE_URL || defaultIntegrationDatabaseUrl;
  process.env.DATABASE_URL = integrationDatabaseUrl;

  const databaseName = getDatabaseName(integrationDatabaseUrl);
  const adminUrl = new URL(integrationDatabaseUrl);
  adminUrl.pathname = "/postgres";

  const adminPool = new Pool({ connectionString: adminUrl.toString() });

  await adminPool.query(
    `SELECT pg_terminate_backend(pid)
     FROM pg_stat_activity
     WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [databaseName],
  );
  await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
  await adminPool.query(`CREATE DATABASE "${databaseName}"`);
  await adminPool.end();

  const { runMigrations } = await import("../db/migrate.js");
  await runMigrations(integrationDatabaseUrl);

  return async () => {
    const teardownPool = new Pool({ connectionString: adminUrl.toString() });
    await teardownPool.query(
      `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [databaseName],
    );
    await teardownPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await teardownPool.end();
  };
}
