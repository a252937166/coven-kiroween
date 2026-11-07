// Page-wide session lock shared by both apps (no React, so it is unit-testable in Node).

/**
 * Session lock: at most one sign-in sequence at a time in this page. It is
 * taken synchronously, so a second POST /api/session cannot start while one
 * is pending (a late Set-Cookie could otherwise overwrite the newer session).
 * Start-up, manual role switches and the multi-persona demo setup all use it.
 */
export const sessionLock = { busy: false, listeners: new Set<(busy: boolean) => void>() };

function setSessionBusy(busy: boolean) {
  sessionLock.busy = busy;
  sessionLock.listeners.forEach((l) => l(busy));
}

export function sessionBusy(): boolean {
  return sessionLock.busy;
}

/** Run fn holding the session lock. Returns undefined without running if the lock is held. */
export async function withSessionLock<T>(fn: () => Promise<T>): Promise<T | undefined> {
  if (sessionLock.busy) return undefined;
  setSessionBusy(true);
  try {
    return await fn();
  } finally {
    setSessionBusy(false);
  }
}
