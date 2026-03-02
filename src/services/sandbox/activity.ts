import { config } from "../../config.js";
import { withOrgContextQuery } from "../../db/index.js";

/**
 * Touch last_activity_at, but only if sandboxActivityTouchMinIntervalMs has
 * passed since the last touch. The conditional WHERE makes this safe to call
 * from multiple pods simultaneously — no distributed lock required.
 */
export async function touchActivityThrottled(
  orgId: string,
  agentId: string,
): Promise<void> {
  await withOrgContextQuery(
    orgId,
    `UPDATE agents
     SET last_activity_at = NOW()
     WHERE id = $1
       AND last_activity_at < NOW() - ($2::bigint * INTERVAL '1 millisecond')`,
    [agentId, config.sandboxActivityTouchMinIntervalMs],
  );
}

/**
 * Extend the active stream lease to NOW() + sandboxStreamLeaseTtlMs.
 * GREATEST ensures the timestamp only moves forward (monotonic).
 * Also resets last_activity_at so the idle clock restarts.
 */
export async function refreshStreamLease(
  orgId: string,
  agentId: string,
): Promise<void> {
  await withOrgContextQuery(
    orgId,
    `UPDATE agents
     SET active_stream_lease_until = GREATEST(
           COALESCE(active_stream_lease_until, NOW()),
           NOW() + ($1::bigint * INTERVAL '1 millisecond')
         ),
         last_activity_at = NOW()
     WHERE id = $2`,
    [config.sandboxStreamLeaseTtlMs, agentId],
  );
}
