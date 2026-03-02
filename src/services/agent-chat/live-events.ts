export interface SessionLiveEvent {
  type: string;
  data?: unknown;
  sessionId?: string;
  source?: string;
}

type SessionLiveListener = (event: SessionLiveEvent) => void;

const listenersBySession = new Map<string, Set<SessionLiveListener>>();

export function subscribeSessionLiveEvents(
  sessionId: string,
  listener: SessionLiveListener,
): () => void {
  const key = String(sessionId || "").trim();
  if (!key) {
    return () => {};
  }

  let listeners = listenersBySession.get(key);
  if (!listeners) {
    listeners = new Set<SessionLiveListener>();
    listenersBySession.set(key, listeners);
  }
  listeners.add(listener);

  return () => {
    const current = listenersBySession.get(key);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) {
      listenersBySession.delete(key);
    }
  };
}

export function publishSessionLiveEvent(
  sessionId: string,
  event: SessionLiveEvent,
): number {
  const key = String(sessionId || "").trim();
  if (!key) return 0;

  const listeners = listenersBySession.get(key);
  if (!listeners || listeners.size === 0) {
    return 0;
  }

  const payload: SessionLiveEvent = {
    ...event,
    sessionId: key,
  };

  let delivered = 0;
  for (const listener of listeners) {
    try {
      listener(payload);
      delivered += 1;
    } catch {
      // Ignore subscriber write failures; route handlers clean up on disconnect.
    }
  }
  return delivered;
}
