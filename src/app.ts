import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";

import { config } from "./config.js";
import { query } from "./db/index.js";
import { authMiddleware } from "./middleware/auth.js";
import { csrfCheck } from "./middleware/csrf.js";
import { errorHandler } from "./middleware/error-handler.js";
import { sessionMiddleware } from "./middleware/session.js";
import agentChatRoutes from "./routes/agent-chat.js";
import agentsRoutes from "./routes/agents.js";
import {
  authProtectedRouter,
  authPublicRouter,
  authSessionRouter,
} from "./routes/auth.js";
import internalRoutes from "./routes/internal.js";
import sandboxRoutes from "./routes/sandbox.js";
import skillsRoutes from "./routes/skills.js";
import testCleanupRoutes from "./routes/test-cleanup.js";
import workspaceRoutes from "./routes/workspace.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createApp() {
  const app = express();

  const allowedOrigins = new Set(config.corsAllowedOrigins);
  app.use(
    cors({
      credentials: true,
      origin: (origin, callback) => {
        if (!origin) {
          callback(null, true);
          return;
        }
        const normalized = origin.trim().replace(/\/+$/, "");
        callback(null, allowedOrigins.has(normalized));
      },
    }),
  );
  app.use(express.json({ limit: "10mb" }));

  if (config.nodeEnv === "production") {
    app.set("trust proxy", 1);
  }

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.get("/api/ready", async (_req, res) => {
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error("Database readiness check timed out")),
        config.readinessDbTimeoutMs,
      );
    });

    try {
      await Promise.race([query("SELECT 1"), timeout]);
      res.json({ status: "ready", timestamp: new Date().toISOString() });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Database not reachable";
      res.status(503).json({
        status: "not_ready",
        error: message,
        timestamp: new Date().toISOString(),
      });
    }
  });

  app.use("/api", sessionMiddleware);

  app.use("/api/auth", authPublicRouter);
  app.use("/api/auth", csrfCheck, authSessionRouter);
  app.use("/api/internal", internalRoutes);

  app.use("/api", authMiddleware, csrfCheck);
  app.use("/api/auth", authProtectedRouter);
  app.use("/api/agents", agentsRoutes);
  app.use("/api/skills", skillsRoutes);
  app.use("/api/agent-chat", agentChatRoutes);
  app.use("/api/sandbox", sandboxRoutes);
  app.use("/api/workspace", workspaceRoutes);

  if (config.nodeEnv === "test") {
    app.use("/api/test", testCleanupRoutes);
  }

  if (config.nodeEnv === "production") {
    app.use(express.static(path.join(__dirname, "../client/dist")));

    app.get("/{*path}", (_req, res) => {
      res.sendFile(path.join(__dirname, "../client/dist/index.html"));
    });
  }

  app.use(errorHandler);

  return app;
}
