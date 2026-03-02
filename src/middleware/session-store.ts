import session from "express-session";
import { pool } from "../db/index.js";

const DEFAULT_SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;

export class PostgresSessionStore extends session.Store {
  get(
    sid: string,
    callback: (err?: unknown, session?: session.SessionData | null) => void,
  ): void {
    pool
      .query<{ sess: session.SessionData }>(
        `SELECT sess
         FROM user_sessions
         WHERE sid = $1
           AND expire >= NOW()
         LIMIT 1`,
        [sid],
      )
      .then((result) => {
        callback(undefined, result.rows[0]?.sess || null);
      })
      .catch((error) => {
        callback(error);
      });
  }

  set(
    sid: string,
    sessionData: session.SessionData,
    callback?: (err?: unknown) => void,
  ): void {
    const maxAgeMs =
      Number(sessionData.cookie?.maxAge) || DEFAULT_SESSION_MAX_AGE_MS;
    const expireAt = new Date(Date.now() + maxAgeMs);

    pool
      .query(
        `INSERT INTO user_sessions (sid, sess, expire)
         VALUES ($1, $2, $3)
         ON CONFLICT (sid) DO UPDATE
         SET sess = EXCLUDED.sess,
             expire = EXCLUDED.expire`,
        [sid, sessionData, expireAt],
      )
      .then(() => callback?.())
      .catch((error) => callback?.(error));
  }

  destroy(sid: string, callback?: (err?: unknown) => void): void {
    pool
      .query("DELETE FROM user_sessions WHERE sid = $1", [sid])
      .then(() => callback?.())
      .catch((error) => callback?.(error));
  }

  touch(
    sid: string,
    sessionData: session.SessionData,
    callback?: (err?: unknown) => void,
  ): void {
    const maxAgeMs =
      Number(sessionData.cookie?.maxAge) || DEFAULT_SESSION_MAX_AGE_MS;
    const expireAt = new Date(Date.now() + maxAgeMs);
    pool
      .query("UPDATE user_sessions SET expire = $2 WHERE sid = $1", [
        sid,
        expireAt,
      ])
      .then(() => callback?.())
      .catch((error) => callback?.(error));
  }
}
