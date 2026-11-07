// Last Light: a personal vault handed over when the owner stops checking in
// and enough trustees act together.

import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { Api } from "@coven/ui-kit/api.ts";
import { IndexedDbKeyStore } from "@coven/ui-kit/keystore.ts";
import {
  addItem,
  beginRecovery,
  bundle,
  checkIn,
  completeRecovery,
  hasRecoveryKey,
  listVaults,
  myCard,
  OWNER,
  recordCardIssued,
  setupDemo,
  submitShare,
  type CardContent,
  type VaultStatus,
} from "@coven/ui-kit/lastlight.ts";
import { Badge, clock, ErrorLine, MailViewer, personaName, RecordVerifier, Shell, useAction, usePersonas } from "@coven/ui-kit/components.tsx";
import type { Persona } from "@coven/ui-kit/common.ts";
import type { OpenedVaultItem } from "@coven/core-ts/release";
import type { Receipt } from "@coven/core-ts/records";

const api = new Api({ app: "last-light" });
const ks = new IndexedDbKeyStore("coven-last-light");

const LANTERN: Record<VaultStatus["state"], { icon: string; tone: "ok" | "warn" | "danger" | "info" | "accent"; text: string }> = {
  Lit: { icon: "🏮", tone: "ok", text: "Lit. The owner checked in on time." },
  Flicker: { icon: "🕯️", tone: "warn", text: "Flickering. A check-in was missed; the owner has been reminded." },
  Vigil: { icon: "🌘", tone: "warn", text: "Vigil. The grace period is running. A check-in now cancels the handover." },
  Handover: { icon: "🌑", tone: "danger", text: "Handover. The vigil ended and trustees were told. A check-in still cancels it until release." },
  Released: { icon: "📜", tone: "info", text: "Released. A quorum of trustees rebuilt the vault key." },
};

export function App() {
  const { personas, me, switchTo } = usePersonas(api, "last-light", OWNER);
  const [vaults, setVaults] = useState<VaultStatus[] | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!me) return;
    listVaults(api).then(setVaults, () => setVaults([]));
  }, [me, tick]);

  const v = vaults?.[0];
  return (
    <Shell
      api={api}
      ks={ks}
      title="🏮 Last Light"
      tagline="Hand your vault to the people you trust, when they need it and enough of them agree."
      personas={personas}
      me={me}
      onPersona={switchTo}
      serverNow={v?.server_now ?? null}
      onChanged={refresh}
      clockSteps={[clock.days(7), clock.days(30)]}
    >
      <div className="grid">
        <main>
          {vaults && vaults.length === 0 && me === OWNER && <Setup />}
          {vaults && vaults.length === 0 && me !== OWNER && (
            <section className="card">
              <p>No vault yet. Switch to Mara Hollow (vault owner) to set up the demo.</p>
            </section>
          )}
          {v && me && <VaultView v={v} me={me} personas={personas} onChanged={refresh} />}
        </main>
        <aside>
          {me && <MailViewer api={api} refreshKey={`${me}-${tick}`} />}
          {v && <RecordVerifier api={api} chain={`ll:${v.vault_id}`} current={v.receipt} />}
        </aside>
      </div>
    </Shell>
  );
}

function Setup() {
  const [log, setLog] = useState<string[]>([]);
  const { busy, error, run } = useAction();
  return (
    <section className="card" aria-labelledby="setup-h">
      <h2 id="setup-h">Set up the fictional family</h2>
      <p>
        This creates key pairs in this browser for Mara and her five trustees, then Mara's browser creates a vault key, splits it 3 of 5,
        and seals three letters. Check-ins are due every 30 days, with a 14-day vigil.
      </p>
      <button className="primary" disabled={busy} onClick={() => run(async () => { await setupDemo(api, ks, (s) => setLog((l) => [...l, s])); window.location.reload(); })}>
        Set up demo
      </button>
      <ErrorLine error={error} />
      {log.length > 0 && <pre className="small muted">{log.join("\n")}</pre>}
    </section>
  );
}

function VaultView({ v, me, personas, onChanged }: { v: VaultStatus; me: string; personas: Persona[]; onChanged: () => void }) {
  const l = LANTERN[v.state];
  const { busy, error, run } = useAction();
  const isOwner = me === v.owner_id;
  const isTrustee = v.trustee_ids.includes(me);
  return (
    <>
      <section className="card" aria-labelledby="vault-h">
        <div className="spread">
          <h2 id="vault-h">
            {l.icon} {v.name}
          </h2>
          <Badge tone={l.tone}>{v.state}</Badge>
        </div>
        <p>{l.text}</p>
        <table>
          <tbody>
            <tr><th>Last check-in</th><td>{v.last_checkin_at}</td></tr>
            <tr><th>Next check-in due</th><td>{v.next_due_at} (every {v.cadence_days} days)</td></tr>
            <tr><th>Vigil starts</th><td>{v.vigil_starts_at}</td></tr>
            <tr><th>Handover starts</th><td>{v.handover_at} (after a {v.vigil_days}-day vigil)</td></tr>
            <tr><th>Trustees</th><td>Any {v.threshold} of {v.trustee_ids.map((t) => personaName(personas, t)).join(", ")}</td></tr>
          </tbody>
        </table>
        {isOwner && v.state !== "Released" && (
          <div className="row" style={{ marginTop: "0.75rem" }}>
            <button className="primary" disabled={busy} onClick={() => run(async () => { await checkIn(api, v.vault_id); onChanged(); })}>
              Check in: I'm here
            </button>
            <span className="small muted">A check-in before release cancels any pending handover.</span>
          </div>
        )}
        <ErrorLine error={error} />
        <p className="small muted">
          A missed check-in is a signal that starts recovery. It does not mean the owner has died. Trustees who rebuild the vault key can
          open the whole vault, and any {v.threshold} of them holding the exported bundle could do that offline at any time.
        </p>
      </section>

      <section className="card" aria-labelledby="items-h">
        <h2 id="items-h">Sealed items</h2>
        <table>
          <thead>
            <tr><th>Label</th><th>Deliver to</th><th>Earliest release</th></tr>
          </thead>
          <tbody>
            {v.items.map((i) => (
              <tr key={i.item_id}>
                <td>{i.label}</td>
                <td>{i.deliver_to.join(", ") || "—"}</td>
                <td>{i.earliest_release ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="small muted">
          Names under “deliver to” are routing labels, not separate locks. Earliest release dates are enforced by the online service only.
        </p>
        {isOwner && v.state !== "Released" && <AddItem vaultId={v.vault_id} onChanged={onChanged} />}
      </section>

      {isTrustee && <ShareCard v={v} me={me} personas={personas} onChanged={onChanged} />}
      {isTrustee && <RecoveryPanel v={v} me={me} personas={personas} onChanged={onChanged} />}
      <BundlePanel v={v} />
    </>
  );
}

function AddItem({ vaultId, onChanged }: { vaultId: string; onChanged: () => void }) {
  const [label, setLabel] = useState("");
  const [to, setTo] = useState("");
  const [date, setDate] = useState("");
  const [body, setBody] = useState("");
  const { busy, error, run } = useAction();
  return (
    <details className="card sub" style={{ marginTop: "1rem" }}>
      <summary>Seal a new letter</summary>
      <div className="field"><label htmlFor="ni-label">Label</label><input id="ni-label" value={label} onChange={(e) => setLabel(e.target.value)} /></div>
      <div className="field"><label htmlFor="ni-to">Deliver to (comma separated)</label><input id="ni-to" value={to} onChange={(e) => setTo(e.target.value)} /></div>
      <div className="field"><label htmlFor="ni-date">Earliest release (optional, online policy)</label><input id="ni-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
      <div className="field"><label htmlFor="ni-body">Letter (fictional)</label><textarea id="ni-body" value={body} onChange={(e) => setBody(e.target.value)} /></div>
      <button
        className="primary"
        disabled={busy || !label || !body}
        onClick={() =>
          run(async () => {
            await addItem(api, ks, OWNER, vaultId, {
              label,
              deliverTo: to.split(",").map((s) => s.trim()).filter(Boolean),
              earliestRelease: date || null,
              body,
            });
            setLabel(""); setTo(""); setDate(""); setBody("");
            onChanged();
          })
        }
      >
        Encrypt in this browser and seal
      </button>
      <ErrorLine error={error} />
    </details>
  );
}

function ShareCard({ v, me, personas, onChanged }: { v: VaultStatus; me: string; personas: Persona[]; onChanged: () => void }) {
  const [card, setCard] = useState<(CardContent & { svg: string; receipt: Receipt }) | null>(null);
  const { busy, error, run } = useAction();
  useEffect(() => setCard(null), [me]);
  return (
    <section className="card" aria-labelledby="card-h">
      <h2 id="card-h">My share card</h2>
      <p className="small">
        Your share is stored encrypted to your key. This browser decrypts it and draws the card locally. The QR code and word code never
        leave this page.
      </p>
      {!card && (
        <button
          disabled={busy}
          onClick={() =>
            run(async () => {
              const c = await myCard(api, ks, me, v.vault_id);
              const svg = await QRCode.toString(c.qr, { type: "svg", errorCorrectionLevel: "M", margin: 1 });
              const { receipt } = await recordCardIssued(api, v.vault_id);
              setCard({ ...c, svg, receipt });
              onChanged();
            })
          }
        >
          Show my card
        </button>
      )}
      <ErrorLine error={error} />
      {card && (
        <>
          <div className="print-area">
            <div className="share-card" aria-label="Share card">
              <h3>Last Light recovery share</h3>
              <div className="warning">Contains a recovery share. Store it like a key.</div>
              <p><strong>Vault:</strong> {v.name}<br /><strong>Trustee:</strong> {personaName(personas, me)}<br />
                Any {v.threshold} of {v.trustee_ids.length} trustee shares open this vault.</p>
              <div className="qr" dangerouslySetInnerHTML={{ __html: card.svg }} />
              <p><strong>Word code</strong> (type this if the QR code cannot be read):</p>
              <p className="words">{card.words}</p>
              <p className="small">Receipt at issuance: <span className="mono" style={{ overflowWrap: "anywhere" }}>{card.receipt.length}:{card.receipt.head}</span></p>
            </div>
          </div>
          <div className="row" style={{ marginTop: "0.5rem" }}>
            <button className="primary" onClick={() => window.print()}>Print card</button>
            <button onClick={() => setCard(null)}>Hide card</button>
          </div>
        </>
      )}
    </section>
  );
}

function RecoveryPanel({ v, me, personas, onChanged }: { v: VaultStatus; me: string; personas: Persona[]; onChanged: () => void }) {
  const r = v.recovery;
  const [typed, setTyped] = useState("");
  const [opened, setOpened] = useState<OpenedVaultItem[] | null>(null);
  const [haveKey, setHaveKey] = useState(false);
  const { busy, error, run } = useAction();
  useEffect(() => {
    setOpened(null);
    if (r) hasRecoveryKey(ks, r.recovery_id).then(setHaveKey);
  }, [r?.recovery_id, me]);

  if (v.state !== "Handover" && v.state !== "Released") {
    return (
      <section className="card">
        <h2>Recovery</h2>
        <p className="small muted">Recovery opens only after the vigil ends. Right now the lantern is {v.state.toLowerCase()}.</p>
      </section>
    );
  }
  const submitted = r?.submitted_by.includes(me);
  const isRecoverer = r?.recoverer_id === me;
  return (
    <section className="card" aria-labelledby="recov-h">
      <h2 id="recov-h">Recovery</h2>
      {!r && v.state === "Handover" && (
        <>
          <p className="small">Open a recovery to receive the other trustees' shares in this browser. They are encrypted to a one-time key made here.</p>
          <button className="primary" disabled={busy} onClick={() => run(async () => { await beginRecovery(api, ks, me, v.vault_id); onChanged(); })}>
            Open a recovery as {personaName(personas, me)}
          </button>
        </>
      )}
      {r && (
        <>
          <p className="small">
            Recovery by <strong>{personaName(personas, r.recoverer_id)}</strong> · {r.state} · shares {r.submitted_by.length} of {v.threshold}
            {r.submitted_by.length > 0 && <> ({r.submitted_by.map((t) => personaName(personas, t)).join(", ")})</>}
          </p>
          <p className="small muted">Recoverer key fingerprint <code>{r.fingerprint.slice(0, 32).match(/.{4}/g)!.join(" ")}</code></p>
          {r.state === "Open" && !submitted && (
            <div className="card sub">
              <h3>Submit my share</h3>
              <div className="row">
                <button className="primary" disabled={busy} onClick={() => run(async () => { await submitShare(api, ks, me, v); onChanged(); })}>
                  Use my stored share
                </button>
              </div>
              <div className="field" style={{ marginTop: "0.6rem" }}>
                <label htmlFor="typed">Or type the word code (or paste the QR text) from my printed card</label>
                <input id="typed" className="mono" autoComplete="off" spellCheck={false} value={typed} onChange={(e) => setTyped(e.target.value)} />
              </div>
              <button disabled={busy || !typed.trim()} onClick={() => run(async () => { await submitShare(api, ks, me, v, typed); setTyped(""); onChanged(); })}>
                Submit share from card
              </button>
              <p className="small muted">The code is checked and encrypted in this browser. Only the encrypted envelope is sent.</p>
            </div>
          )}
          {submitted && r.state === "Open" && <p className="small muted">You submitted your share. Submitting again does not count twice.</p>}
          {isRecoverer && (r.state === "Open" || r.state === "Complete") && (
            <div className="row">
              <button
                className="primary"
                disabled={busy || !haveKey || r.submitted_by.length < v.threshold}
                onClick={() => run(async () => { const res = await completeRecovery(api, ks, r.recovery_id); setOpened(res.items); onChanged(); })}
              >
                Rebuild the vault key here and open
              </button>
              {r.submitted_by.length < v.threshold && <span className="small muted">Waiting for {v.threshold - r.submitted_by.length} more.</span>}
              {!haveKey && <span className="small muted">This browser does not hold the recovery key.</span>}
            </div>
          )}
        </>
      )}
      <ErrorLine error={error} />
      {opened && (
        <div className="stack" style={{ marginTop: "0.75rem" }}>
          {opened.map((it) => (
            <article className="card sub" key={it.itemId}>
              <div className="spread">
                <h3>{it.label}</h3>
                <span className="small muted">for {it.deliverTo.join(", ") || "anyone"}</span>
              </div>
              {it.withheld ? (
                <p className="notice small">Held online until {it.earliestRelease}. This date is online policy only.</p>
              ) : (
                <div className="secret">{it.body}</div>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function BundlePanel({ v }: { v: VaultStatus }) {
  const { busy, error, run } = useAction();
  return (
    <section className="card" aria-labelledby="bundle-h">
      <h2 id="bundle-h">Offline bundle</h2>
      <p className="small">
        The bundle holds ciphertext and the record snapshot, no shares or keys. With it and any {v.threshold} shares, the offline tool opens
        the vault without this service:
      </p>
      <pre className="small mono" style={{ whiteSpace: "pre-wrap" }}>node core-ts/bin/recover.js bundle.json</pre>
      <button
        disabled={busy}
        onClick={() =>
          run(async () => {
            const b = await bundle(api, v.vault_id);
            const url = URL.createObjectURL(new Blob([JSON.stringify(b, null, 2)], { type: "application/json" }));
            const a = document.createElement("a");
            a.href = url;
            a.download = `last-light-bundle-${v.vault_id.slice(0, 8)}.json`;
            a.click();
            URL.revokeObjectURL(url);
          })
        }
      >
        Download bundle
      </button>
      <ErrorLine error={error} />
    </section>
  );
}
