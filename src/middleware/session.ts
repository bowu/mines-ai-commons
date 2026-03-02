import crypto from "node:crypto";
import session from "express-session";
import { config } from "../config.js";
import { PostgresSessionStore } from "./session-store.js";

const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;

function resolveSessionSecret(): string {
  if (config.nodeEnv === "production" && !config.sessionSecret) {
    throw new Error("SESSION_SECRET is required in production");
  }

  if (config.sessionSecret) {
    return config.sessionSecret;
  }

  return crypto.randomBytes(32).toString("hex");
}

const sessionSecret = resolveSessionSecret();

export const sessionMiddleware = session({
  name: "sid",
  secret: sessionSecret,
  store: config.nodeEnv === "test" ? undefined : new PostgresSessionStore(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: config.nodeEnv === "production",
    sameSite: "lax",
    path: "/api",
    maxAge: SESSION_DURATION_MS,
  },
});
