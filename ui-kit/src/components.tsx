// Shared React pieces for both apps. Layout and look belong to each app.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { Receipt, RecordEntry, ReceiptOutcome } from "@coven/core-ts/records";
import { Api, ApiError } from "./api.ts";
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
export function RoleSwitch({ personas, me, onPersona }: { personas: Persona[]; me: string | null; onPersona: (id: string) => void }) {
  return (
    <div className="role-switch">
      <label htmlFor="persona">Signed in as</label>
      <select id="persona" value={me ?? ""} onChange={(e) => onPersona(e.target.value)}>
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
      <button
        className="danger"
        disabled={busy}
        onClick={() => {
          if (window.confirm("Reset the demo? This deletes all demo data and this browser's demo keys.")) {
            run(async () => {
              await resetDemo(props.api, props.ks);
              window.location.reload();
            });
          }
        }}
      >
        Reset demo
      </button>
      <span className="visually-hidden">The demo clock speeds up waiting only; all cryptography runs for real.</span>
      <ErrorLine error={error} />
    </div>
  );
}

export function MailViewer({ api, refreshKey }: { api: Api; refreshKey: unknown }) {
  const [items, setItems] = useState<Mail[]>([]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    mail(api).then(setItems, (e) => setErr(errorText(e)));
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
    api
      .get<{ entries: RecordEntry[] }>(`/api/records/${encodeURIComponent(chain)}`)
      .then((r) => setEntry(r.entries[r.entries.length - 1] ?? null), () => setEntry(null));
  }, [api, chain, refreshKey]);
  return entry;
}

/** Load personas for this app and keep a signed-in session. */
export function usePersonas(api: Api, app: string, fallback: string) {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [me, setMe] = useState<string | null>(null);
  useEffect(() => {
    (async () => {
      const all = await api.get<Persona[]>("/api/personas");
      setPersonas(all.filter((p) => p.app === app));
      try {
        const s = await api.get<{ user: string }>("/api/session");
        setMe(s.user);
      } catch {
        await api.signIn(fallback);
        setMe(fallback);
      }
    })();
  }, [api, app, fallback]);
  const switchTo = useCallback(
    async (id: string) => {
      await api.signIn(id);
      setMe(id);
    },
    [api],
  );
  return { personas, me, switchTo };
}

export function personaName(personas: Persona[], id: string) {
  return personas.find((p) => p.id === id)?.name ?? id.replace(/^user:/, "");
}

export function personaRole(personas: Persona[], id: string) {
  return personas.find((p) => p.id === id)?.role ?? "";
}
