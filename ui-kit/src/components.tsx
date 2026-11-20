// Shared React pieces for both apps. Layout and look belong to each app.

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Receipt, RecordEntry, ReceiptOutcome } from "@coven/core-ts/records";
import { Api, ApiError } from "./api.ts";
import { sessionLock, withSessionLock } from "./session.ts";

export { sessionBusy, withSessionLock } from "./session.ts";
import { advanceClock, checkChain, mail, parseReceipt, resetDemo, type Mail, type Persona } from "./common.ts";
import type { KeyStore } from "./keystore.ts";

export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    const detail = e.body.detail ? `: ${String(e.body.detail)}` : "";
    return `${e.code.replace(/_/g, " ")}${detail} (HTTP ${e.status})`;
  }
  return e instanceof Error ? e.message : String(e);
}

/** Run an async action, tracking busy state and errors. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(errorText(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, setError };
}

export type Tone = "" | "ok" | "warn" | "danger" | "info" | "accent" | "quiet";

export function Badge({ tone = "", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function Chip({ tone = "quiet", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`chip ${tone}`}>{children}</span>;
}

export function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <p className="error" role="alert">
      {error}
    </p>
  ) : null;
}

/** "2026-11-07 18:31:37 UTC" from an ISO string; the service clock is UTC. */
export function utc(iso: string | null | undefined, withSeconds = true): string {
  if (!iso) return "…";
  const t = iso.replace("T", " ").replace("Z", "");
  return `${withSeconds ? t : t.slice(0, 16)} UTC`;
}

export function utcDate(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : "…";
}

/** The shared Coven mark: three overlapping rings. Original, inline, decorative. */
export function CovenMark() {
  return (
    <span className="coven-mark">
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <g fill="none" stroke="currentColor" strokeWidth="1.6">
          <circle cx="12" cy="8.5" r="5" />
          <circle cx="8.2" cy="15" r="5" />
          <circle cx="15.8" cy="15" r="5" />
        </g>
      </svg>
      Coven
    </span>
  );
}

/** Switches which fictional persona is signed in. Navigation only: no other side effect. */
export function RoleSwitch(props: {
  personas: Persona[];
  me: string | null;
  onPersona: (id: string) => void;
  /** True while any sign-in (manual switch, start-up or demo setup) is in flight. */
  pending?: boolean;
}) {
  const { personas, me, onPersona, pending = false } = props;
  return (
    <div className="role-switch">
      <label htmlFor="persona">Signed in as</label>
      <select
        id="persona"
        value={me ?? ""}
        disabled={pending}
        aria-busy={pending || undefined}
        onChange={(e) => onPersona(e.target.value)}
      >
        {me === null && <option value="">…</option>}
        {personas.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} · {p.role}
          </option>
        ))}
      </select>
    </div>
  );
}

const DAY = 86400;

export const clock = {
  minutes: (n: number) => ({ label: `+${n} min`, seconds: n * 60 }),
  days: (n: number) => ({ label: `+${n} days`, seconds: n * DAY }),
};

/** Compact, clearly fictional demo controls. Moving the clock is a deliberate click. */
export function DemoClock(props: {
  api: Api;
  ks: KeyStore;
  serverNow: string | null;
  steps: { label: string; seconds: number }[];
  onChanged: () => void;
}) {
  const { busy, error, run } = useAction();
  return (
    <div className="demo-strip" role="group" aria-label="Demo controls">
      <span className="tag">Fictional demo</span>
      <span>
        Service clock <time className="tnum">{utc(props.serverNow, false)}</time>
      </span>
      {props.steps.map((s) => (
        <button key={s.label} disabled={busy} onClick={() => run(async () => { await advanceClock(props.api, s.seconds); props.onChanged(); })}>
          {s.label}
        </button>
      ))}
      <ResetDemo api={props.api} ks={props.ks} disabled={busy} />
      <span className="visually-hidden">The demo clock speeds up waiting only; all cryptography runs for real.</span>
      <ErrorLine error={error} />
    </div>
  );
}

const APP_NAME: Record<string, string> = { "last-light": "Last Light", "break-glass": "Break Glass" };
const APP_DATA: Record<string, string> = {
  "last-light": "vaults, letters, shares and recoveries",
  "break-glass": "sealed items, petitions and approvals",
};

type DemoSpace = { private: boolean; idleDays?: number };

/** Hosted: this browser has a private demo space. Local (or an older service): one shared demo. */
function useDemoSpace(api: Api): DemoSpace {
  const [space, setSpace] = useState<DemoSpace>({ private: false });
  useEffect(() => {
    let stale = false;
    api.get<{ private: boolean; idle_days?: number }>("/api/demo/space").then(
      (s) => {
        if (!stale) setSpace({ private: s.private === true, idleDays: s.idle_days });
      },
      () => undefined,
    );
    return () => {
      stale = true;
    };
  }, [api]);
  return space;
}

/**
 * Reset demo, confirmed in the app's own modal dialog instead of a native
 * confirm. Opening and cancelling never reset anything. A press while a reset
 * is pending is ignored, so one confirmation sends one reset. A failure stays
 * visible in the dialog, which can then be retried or cancelled. The dialog is
 * rendered at the end of <body>, outside the app and the printable card.
 */
function ResetDemo({ api, ks, disabled }: { api: Api; ks: KeyStore; disabled: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const descId = useId();
  const here = APP_NAME[api.app] ?? "this app's";
  const space = useDemoSpace(api);

  const open = () => {
    const d = dialog.current;
    if (!d || d.open) return;
    setError(null);
    d.showModal();
    cancel.current?.focus(); // the safe choice has focus first
  };
  const close = () => {
    if (!inFlight.current) dialog.current?.close();
  };
  const confirm = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      await resetDemo(api, ks);
      window.location.reload(); // stays pending until the page reloads
    } catch (e) {
      inFlight.current = false;
      setPending(false);
      setError(errorText(e));
    }
  };

  return (
    <>
      <button ref={trigger} className="danger" disabled={disabled} aria-haspopup="dialog" onClick={open}>
        Reset demo
      </button>
      {createPortal(
        <dialog
          ref={dialog}
          className="coven-dialog"
          aria-labelledby={titleId}
          aria-describedby={descId}
          onCancel={(e) => {
            if (inFlight.current) e.preventDefault(); // Escape cannot abandon a reset in flight
          }}
          onClose={() => {
            setError(null);
            trigger.current?.focus();
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) close(); // a click on the backdrop cancels
          }}
        >
          <div className="coven-dialog-panel">
            <div className="coven-dialog-head">
              <span className="coven-dialog-icon" aria-hidden="true">
                !
              </span>
              <div>
                <p className="coven-dialog-kicker">Fictional demo</p>
                <h2 id={titleId} className="coven-dialog-title">
                  Reset the demo?
                </h2>
              </div>
            </div>
            <p id={descId} className="coven-dialog-desc">
              {space.private ? (
                <>
                  This deletes the demo data in your private {here} demo space, which only this browser uses. Other people's demos are not
                  affected. It also deletes the {here} demo keys stored in this browser.
                </>
              ) : (
                <>
                  This deletes the demo data of both apps, Last Light and Break Glass, on this demo service. It also deletes the {here} demo
                  keys stored in this browser.
                </>
              )}
            </p>
            <ul className="coven-dialog-list">
              {space.private ? (
                <>
                  <li>
                    <b>{here}</b> <span>{APP_DATA[api.app]}</span>
                  </li>
                  <li>
                    <b>Your space</b> <span>records, demo mail, enrolled keys, sign-ins and the demo clock</span>
                  </li>
                </>
              ) : (
                <>
                  <li>
                    <b>Last Light</b> <span>vaults, letters, shares and recoveries</span>
                  </li>
                  <li>
                    <b>Break Glass</b> <span>sealed items, petitions and approvals</span>
                  </li>
                  <li>
                    <b>Both apps</b> <span>records, demo mail, enrolled keys, sign-ins and the demo clock</span>
                  </li>
                </>
              )}
              <li>
                <b>This browser</b> <span>{here} demo keys</span>
              </li>
            </ul>
            <p className="coven-dialog-note">
              Nothing is deleted until you confirm. After the reset, set up the demo again.
              {space.private && space.idleDays ? ` A space nobody uses for ${space.idleDays} days is deleted.` : ""}
            </p>
            {error && (
              <p className="coven-dialog-error" role="alert">
                The reset did not finish: {error}
              </p>
            )}
            <div className="coven-dialog-actions">
              <button ref={cancel} type="button" className="coven-dialog-cancel" disabled={pending} onClick={close}>
                Cancel
              </button>
              <button type="button" className="coven-dialog-confirm" disabled={pending} onClick={() => void confirm()}>
                {pending ? "Resetting…" : "Reset all demo data"}
              </button>
            </div>
          </div>
        </dialog>,
        document.body,
      )}
    </>
  );
}

export function MailViewer({ api, refreshKey }: { api: Api; refreshKey: unknown }) {
  const [items, setItems] = useState<Mail[]>([]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    const e = roleEpoch.n;
    mail(api).then(
      (m) => { if (!stale && isCurrentEpoch(e)) setItems(m); },
      (err) => { if (!stale) setErr(errorText(err)); },
    );
    return () => { stale = true; };
  }, [api, refreshKey]);
  return (
    <section aria-labelledby="mail-h">
      <h3 id="mail-h">Demo mail</h3>
      <p className="small muted">Notifications for the signed-in persona. No real email is sent.</p>
      <ErrorLine error={err} />
      {items.length === 0 && <p className="muted small">No messages.</p>}
      {items.slice(0, 8).map((m) => (
        <div className="mail-item" key={m.id}>
          <div className="spread">
            <strong className="small">{m.subject}</strong>
            <span className="small muted tnum">{utc(m.at, false)}</span>
          </div>
          <div className="small wrap-anywhere">{m.body}</div>
        </div>
      ))}
    </section>
  );
}

const OUTCOME: Record<ReceiptOutcome, { title: string; text: (n: number) => string }> = {
  consistent: {
    title: "Consistent",
    text: (n) => `The first ${n} entries still hash to this receipt.`,
  },
  altered: {
    title: "Witnessed prefix altered",
    text: (n) => `One or more of the first ${n} entries were changed, removed or reordered. A receipt alone cannot say which.`,
  },
  truncated: {
    title: "Truncated",
    text: (n) => `The record now holds fewer than the ${n} entries this receipt witnessed.`,
  },
};

/** Verify the service's record against a receipt the user kept. Runs in the browser. */
export function RecordVerifier({ api, chain, current }: { api: Api; chain: string; current: Receipt | null }) {
  const [text, setText] = useState("");
  const [result, setResult] = useState<{ outcome: ReceiptOutcome; n: number; length: number } | null>(null);
  const { busy, error, run } = useAction();
  return (
    <section aria-labelledby="rec-h">
      <h3 id="rec-h">Record and receipts</h3>
      {current && (
        <p className="small">
          Current receipt: <code className="wrap-anywhere">{`${current.length}:${current.head}`}</code>
        </p>
      )}
      <div className="field">
        <label htmlFor="receipt-in">Check a receipt you kept (from a card or a mail)</label>
        <input id="receipt-in" className="mono" placeholder="12:ab34…" value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      <button
        disabled={busy || !text}
        onClick={() =>
          run(async () => {
            const receipt = parseReceipt(text);
            const r = await checkChain(api, chain, receipt);
            setResult({ outcome: r.outcome, n: receipt.length, length: r.length });
          })
        }
      >
        Verify in this browser
      </button>
      <ErrorLine error={error} />
      {result && (
        <div className={`outcome ${result.outcome}`} role="status">
          <strong>{OUTCOME[result.outcome].title}</strong>
          <span>
            {OUTCOME[result.outcome].text(result.n)} The service now holds {result.length} entries.
          </span>
        </div>
      )}
      <p className="small muted">
        A receipt checks the prefix it witnessed. Finding which entry changed needs a retained copy, such as the snapshot in an exported bundle.
      </p>
    </section>
  );
}

/** The newest record entry, for a "what just happened" line. */
export function useLatestRecord(api: Api, chain: string | null, refreshKey: unknown) {
  const [entry, setEntry] = useState<RecordEntry | null>(null);
  useEffect(() => {
    if (!chain) return;
    let stale = false;
    const e = roleEpoch.n;
    api
      .get<{ entries: RecordEntry[] }>(`/api/records/${encodeURIComponent(chain)}`)
      .then(
        (r) => { if (!stale && isCurrentEpoch(e)) setEntry(r.entries[r.entries.length - 1] ?? null); },
        () => { if (!stale) setEntry(null); },
      );
    return () => { stale = true; };
  }, [api, chain, refreshKey]);
  return entry;
}

/**
 * Role epoch: bumped synchronously when a persona switch STARTS, before the
 * new session cookie exists. Async work captures the epoch when it begins and
 * must drop its result (and send no further requests) if the epoch moved, so
 * one persona's response can never land in another persona's view.
 */
const roleEpoch = { n: 0 };

export function currentEpoch(): number {
  return roleEpoch.n;
}

export function isCurrentEpoch(e: number): boolean {
  return e === roleEpoch.n;
}

export function useSessionBusy(): boolean {
  const [busy, setBusy] = useState(sessionLock.busy);
  useEffect(() => {
    sessionLock.listeners.add(setBusy);
    setBusy(sessionLock.busy);
    return () => {
      sessionLock.listeners.delete(setBusy);
    };
  }, []);
  return busy;
}

/** The persona the session cookie holds; null when there is no session. Throws when the service cannot be reached. */
async function readSession(api: Api): Promise<string | null> {
  try {
    return (await api.get<{ user: string }>("/api/session")).user;
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return null;
    throw e;
  }
}

/**
 * Load personas for this app and keep a signed-in session. `me` is always the
 * persona the service reports for the session cookie, read back after every
 * sign-in, so the UI never claims a persona the cookie does not hold. When the
 * session cannot be started or read back, `sessionError` says so and
 * `retrySession` tries again; nothing role-scoped is shown meanwhile.
 */
export function usePersonas(api: Api, app: string, fallback: string) {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [me, setMe] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(roleEpoch.n);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const pending = useSessionBusy();
  const meRef = useRef<string | null>(null);
  const settle = (user: string | null) => {
    meRef.current = user;
    setMe(user);
  };
  /** Read the session back after a sign-in attempt; a failure is shown, never guessed. */
  const readBack = async (refused?: unknown): Promise<string | null> => {
    try {
      const user = await readSession(api);
      // When the service answered the sign-in with a refusal (for example a busy or full demo), say why.
      if (user === null) setSessionError(refused instanceof ApiError ? errorText(refused) : "the service did not keep a demo session");
      return user;
    } catch (e) {
      setSessionError(errorText(e));
      return null;
    }
  };

  const start = useCallback(async () => {
    setSessionError(null);
    try {
      const all = await api.get<Persona[]>("/api/personas");
      setPersonas(all.filter((p) => p.app === app));
      let user = await readSession(api);
      if (user === null) {
        let refused: unknown;
        try {
          await api.signIn(fallback);
        } catch (e) {
          refused = e; // ambiguous: the cookie may or may not have been set; read it back below
        }
        user = await readBack(refused);
      }
      settle(user);
    } catch (e) {
      setSessionError(errorText(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, app, fallback]);

  useEffect(() => {
    void withSessionLock(start);
  }, [start]);

  const retrySession = useCallback(() => {
    void withSessionLock(async () => {
      roleEpoch.n += 1;
      setEpoch(roleEpoch.n); // anything started before the failure is discarded
      await start();
    });
  }, [start]);

  const switchTo = useCallback(
    async (id: string) => {
      if (id === meRef.current) return; // already this persona: no sign-in
      await withSessionLock(async () => {
        roleEpoch.n += 1;
        const e = roleEpoch.n;
        setEpoch(e); // remount role-scoped views now, before the network round trip
        setSessionError(null);
        let refused: unknown;
        try {
          await api.signIn(id);
        } catch (err) {
          refused = err; // ambiguous failure: confirm which session the cookie actually holds
        }
        const user = await readBack(refused);
        if (isCurrentEpoch(e)) settle(user);
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api],
  );

  /** For flows that sign in internally (demo setup): run under the same lock, then re-read the session. */
  const runSignedInFlow = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
      return withSessionLock(async () => {
        roleEpoch.n += 1;
        setEpoch(roleEpoch.n);
        try {
          return await fn();
        } finally {
          settle(await readBack());
        }
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api],
  );

  return { personas, me, switchTo, epoch, pending, runSignedInFlow, sessionError, retrySession };
}

/** Shown while data for the signed-in persona is on its way. */
export function Loading({ what }: { what: string }) {
  return (
    <p className="load-wait" role="status">
      <span className="load-wait-dot" aria-hidden="true" />
      Loading {what}…
    </p>
  );
}

/**
 * A load that failed, with what failed and a way to try again. Data shown
 * earlier (if any) stays on the page below it, marked as possibly out of date.
 */
export function LoadProblem({ what, error, onRetry, stale = false }: { what: string; error: string; onRetry: () => void; stale?: boolean }) {
  return (
    <div className="load-problem" role="alert">
      <p className="load-problem-text">
        <strong>Could not load {what}.</strong> {error}
        {stale && " What is shown below may be out of date."}
      </p>
      <button type="button" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

export function personaName(personas: Persona[], id: string) {
  return personas.find((p) => p.id === id)?.name ?? id.replace(/^user:/, "");
}

export function personaRole(personas: Persona[], id: string) {
  return personas.find((p) => p.id === id)?.role ?? "";
}
