import type { Server } from "node:http";

import { createApp } from "./app.js";
import { config } from "./config.js";
import { closePools, initDatabase, pool } from "./db/index.js";
import {
  startReconciler,
  stopReconciler,
} from "./services/sandbox/reconciler.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;

let server: Server | null = null;
let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`Received ${signal}. Shutting down...`);

  try {
    await Promise.race([
      new Promise<void>((resolve) => {
        if (!server) {
          resolve();
          return;
        }

        server.close((error) => {
          if (error) {
            console.error("HTTP server close error:", error);
          }
          resolve();
        });
      }),
      new Promise<void>((resolve) => {
        setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
      }),
    ]);

    await stopReconciler();
    await closePools();
    console.log("Shutdown complete");
    process.exit(0);
  } catch (error) {
    console.error("Shutdown error:", error);
    process.exit(1);
  }
}

async function start() {
  try {
    await initDatabase();
    console.log("Database initialized");

    // Refresh last_activity_at for all running VMs on startup so that
    // stale pre-restart timestamps don't trigger immediate idle detection.
    await pool.query(
      `UPDATE agents SET last_activity_at = NOW()
       WHERE desired_vm_state = 'running' AND deleted_at IS NULL`,
    );

    const app = createApp();
    startReconciler();
    server = app.listen(config.port, "0.0.0.0", () => {
      console.log(`Server running on http://0.0.0.0:${config.port}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});

start();
