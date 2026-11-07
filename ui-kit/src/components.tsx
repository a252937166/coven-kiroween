// Shared React components for both apps.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { Receipt } from "@coven/core-ts/records";
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

export function Badge({ tone = "", children }: { tone?: "" | "ok" | "warn" | "danger" | "info" | "accent"; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <p className="error" role="alert">
      {error}
    </p>
  ) : null;
}

const DAY = 86400;

export interface ShellProps {
  api: Api;
  ks: KeyStore;
  title: string;
  tagline: string;
  personas: Persona[];
  me: string | null;
  onPersona: (id: string) => void;
  serverNow: string | null;
  onChanged: () => void;
  clockSteps: { label: string; seconds: number }[];
  children: ReactNode;
}

/** Header with persona switcher, labelled demo clock and reset. */
export function Shell(props: ShellProps) {
  const { api, ks, personas, me, onPersona, serverNow, onChanged, clockSteps } = props;
  const { busy, error, run } = useAction();
  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <strong>{props.title}</strong>
          <span>{props.tagline}</span>
        </div>
        <div className="controls">
          <label htmlFor="persona" className="small" style={{ margin: 0 }}>
            Signed in as
          </label>
          <select id="persona" value={me ?? ""} onChange={(e) => onPersona(e.target.value)}>
            {personas.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.role}
              </option>
            ))}
          </select>
        </div>
      </header>
      <div className="demo-banner" role="note">
        <strong>Demo mode.</strong>
        <span>Fictional people and data. One browser plays every persona.</span>
        <span>
          Demo clock: <code>{serverNow ?? "…"}</code>. It speeds up waiting only; all cryptography runs for real.
        </span>
        {clockSteps.map((s) => (
          <button key={s.label} disabled={busy} onClick={() => run(async () => { await advanceClock(api, s.seconds); onChanged(); })}>
            {s.label}
          </button>
        ))}
        <button
          className="danger"
          disabled={busy}
          onClick={() => {
            if (window.confirm("Reset the demo? This deletes all demo data and this browser's demo keys.")) {
              run(async () => {
                await resetDemo(api, ks);
                window.location.reload();
              });
            }
          }}
        >
          Reset demo
        </button>
        <ErrorLine error={error} />
      </div>
      {props.children}
    </div>
  );
}

export const clock = {
  minutes: (n: number) => ({ label: `+${n} min`, seconds: n * 60 }),
  days: (n: number) => ({ label: `+${n} days`, seconds: n * DAY }),
};

export function MailViewer({ api, refreshKey }: { api: Api; refreshKey: unknown }) {
  const [items, setItems] = useState<Mail[]>([]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    mail(api).then(setItems, (e) => setErr(errorText(e)));
  }, [api, refreshKey]);
  return (
    <section className="card" aria-labelledby="mail-h">
      <h2 id="mail-h">Demo mail</h2>
      <p className="small muted">Notifications for the signed-in persona. No real email is sent.</p>
      <ErrorLine error={err} />
      {items.length === 0 && <p className="muted small">No messages.</p>}
      {items.slice(0, 8).map((m) => (
        <div className="mail-item" key={m.id}>
          <div className="spread">
            <strong className="small">{m.subject}</strong>
            <span className="small muted">{m.at}</span>
          </div>
          <div className="small" style={{ overflowWrap: "anywhere" }}>{m.body}</div>
        </div>
      ))}
    </section>
  );
}

/** Verify the service's record against a receipt the user kept. */
export function RecordVerifier({ api, chain, current }: { api: Api; chain: string; current: Receipt | null }) {
  const [text, setText] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const outcomes: Record<string, string> = {
    consistent: "Consistent: the witnessed prefix matches the receipt.",
    altered: "Witnessed prefix altered: one or more entries up to that point changed, were removed or were reordered. A receipt alone cannot say which.",
    truncated: "Truncated: the record is shorter than the receipt.",
  };
  return (
    <section className="card" aria-labelledby="rec-h">
      <h2 id="rec-h">Record and receipts</h2>
      {current && (
        <p className="small">
          Current receipt: <code style={{ overflowWrap: "anywhere" }}>{`${current.length}:${current.head}`}</code>
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
            const r = await checkChain(api, chain, parseReceipt(text));
            setResult(`${outcomes[r.outcome]} The service now holds ${r.length} entries.`);
          })
        }
      >
        Verify in this browser
      </button>
      <ErrorLine error={error} />
      {result && <p className="notice ok small">{result}</p>}
      <p className="small muted">
        A receipt checks the prefix it witnessed. Finding which entry changed needs a retained copy, such as the snapshot in an exported bundle.
      </p>
    </section>
  );
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
