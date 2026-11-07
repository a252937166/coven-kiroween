// Last Light: a family archive handed over when the owner stops checking in
// and enough trustees act together.

import { useCallback, useEffect, useRef, useState } from "react";
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
import {
  clock,
  currentEpoch,
  CovenMark,
  DemoClock,
  ErrorLine,
  isCurrentEpoch,
  MailViewer,
  personaName,
  RecordVerifier,
  RoleSwitch,
  useAction,
  useLatestRecord,
  usePersonas,
  utc,
  utcDate,
} from "@coven/ui-kit/components.tsx";
import type { Persona } from "@coven/ui-kit/common.ts";
import { RecoveryIncompleteError, type OpenedRecovery } from "@coven/core-ts/release";
import type { Receipt, RecordEntry } from "@coven/core-ts/records";
import { Lantern, SealedLetter } from "./Lantern.tsx";

const api = new Api({ app: "last-light" });
const ks = new IndexedDbKeyStore("coven-last-light");

type State = VaultStatus["state"];

const STATE_LINE: Record<State, string> = {
  Lit: "The lantern is lit. The owner checked in on time.",
  Flicker: "The lantern is flickering. A check-in was missed, and the owner has been reminded.",
  Vigil: "The vigil is running. A check-in now still cancels the handover.",
  Handover: "Handover has started. The vigil ended and the trustees were told. A check-in still cancels it until release.",
  Released:
    "Released. The service sent the encrypted package to the recovering trustee. The vault key is rebuilt and checked in that trustee's browser.",
};

const STAGES: State[] = ["Lit", "Flicker", "Vigil", "Handover", "Released"];

const EVENT: Record<string, string> = {
  "vault.created": "The vault was created",
  "item.sealed": "A letter was sealed",
  "card.issued": "A trustee opened their share card",
  checkin: "The owner checked in",
  "lantern.flicker": "The lantern began to flicker",
  "lantern.vigil": "The vigil began",
  "lantern.handover": "Handover started",
  "recovery.opened": "A trustee opened a recovery",
  "recovery.share_submitted": "A trustee submitted a share",
  "lantern.released": "The encrypted package was sent to the recovering trustee",
  "bundle.exported": "An offline bundle was exported",
};

function LatestLine({ entry }: { entry: RecordEntry | null }) {
  if (!entry) return null;
  return (
    <p className="ll-latest small">
      <span className="muted">Last recorded</span> {EVENT[entry.type] ?? entry.type} · <time className="tnum">{utc(entry.at, false)}</time>
    </p>
  );
}

/** True while the component is mounted and the persona has not changed since `epoch`. */
function useLive(epoch: number) {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return useCallback(() => mounted.current && isCurrentEpoch(epoch), [epoch]);
}

export function App() {
  const { personas, me, switchTo, epoch, pending, runSignedInFlow } = usePersonas(api, "last-light", OWNER);
  const [vaults, setVaults] = useState<VaultStatus[] | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!me || pending) return; // never load role-scoped data while the session is changing
    let stale = false;
    const e = currentEpoch();
    listVaults(api).then(
      (vs) => { if (!stale && isCurrentEpoch(e)) setVaults(vs); },
      () => { if (!stale) setVaults([]); },
    );
    return () => { stale = true; };
  }, [me, epoch, pending, tick]);

  const v = vaults?.[0];
  const latest = useLatestRecord(api, v ? `ll:${v.vault_id}` : null, `${tick}-${me}-${v?.receipt.length}`);
  return (
    <div className="ll-app">
      <a className="skip" href="#main">Skip to content</a>
      <header className="ll-top">
        <div className="ll-brand">
          <CovenMark />
          <span className="ll-wordmark">Last Light</span>
          <span className="ll-tagline">A family archive, opened together when it is needed.</span>
        </div>
        <RoleSwitch personas={personas} me={me} onPersona={switchTo} pending={pending} />
      </header>
      {/* While any sign-in is in flight, everything role-scoped is inert. */}
      <div className="ll-demo" inert={pending}>
        <DemoClock api={api} ks={ks} serverNow={v?.server_now ?? null} steps={[clock.days(7), clock.days(30)]} onChanged={refresh} />
      </div>

      <main id="main" className="ll-main" inert={pending} aria-busy={pending}>
        {vaults && vaults.length === 0 && me === OWNER && <Setup runSignedInFlow={runSignedInFlow} />}
        {vaults && vaults.length === 0 && me !== OWNER && (
          <section className="ll-folio">
            <p>No vault yet. Switch to Mara Hollow (vault owner) to set up the demo.</p>
          </section>
        )}
        {v && me && <VaultView v={v} me={me} epoch={epoch} personas={personas} latest={latest} onChanged={refresh} />}
      </main>

      {v && me && (
        <aside className="ll-proof" aria-labelledby="proof-h" inert={pending}>
          <h2 id="proof-h" className="ll-section-title">Proof, mail and offline copy</h2>
          <div className="ll-proof-grid">
            <details className="evidence">
              <summary>Offline bundle</summary>
              <div className="body">
                <BundlePanel v={v} />
              </div>
            </details>
            <details className="evidence">
              <summary>Record and receipts</summary>
              <div className="body">
                <RecordVerifier api={api} chain={`ll:${v.vault_id}`} current={v.receipt} />
              </div>
            </details>
            <details className="evidence">
              <summary>Demo mail</summary>
              <div className="body">
                <MailViewer api={api} refreshKey={`${me}-${tick}`} />
              </div>
            </details>
          </div>
        </aside>
      )}
    </div>
  );
}

function Setup({ runSignedInFlow }: { runSignedInFlow: <T>(fn: () => Promise<T>) => Promise<T | undefined> }) {
  const [log, setLog] = useState<string[]>([]);
  const { busy, error, run } = useAction();
  return (
    <section className="ll-hero" aria-labelledby="setup-h">
      <div className="ll-folio">
        <p className="ll-kicker">Folio · first evening</p>
        <h1 id="setup-h">Set up the fictional family</h1>
        <p className="ll-lede">
          Mara Hollow keeps letters for her family. Five trustees each hold one piece of the key; any three can open the vault together.
        </p>
        <p className="small muted">
          This creates key pairs in this browser for Mara and her five trustees. Mara's browser then makes a vault key, splits it 3 of 5 and
          seals three letters. Check-ins are due every 30 days, with a 14-day vigil.
        </p>
        <button
          className="primary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              // Internal sign-ins and key enrollment hold the session lock: no manual switch can interleave.
              await runSignedInFlow(() => setupDemo(api, ks, (s) => setLog((l) => [...l, s])));
              window.location.reload();
            })
          }
        >
          Set up demo
        </button>
        <ErrorLine error={error} />
        {log.length > 0 && <pre className="small muted">{log.join("\n")}</pre>}
      </div>
      <div className="ll-lamp">
        <SealedLetter />
      </div>
    </section>
  );
}

function StageLedger({ v }: { v: VaultStatus }) {
  const when: Record<State, string> = {
    Lit: `until ${utcDate(v.next_due_at)}`,
    Flicker: `from ${utcDate(v.next_due_at)}`,
    Vigil: `from ${utcDate(v.vigil_starts_at)}`,
    Handover: `from ${utcDate(v.handover_at)}`,
    Released: "when a quorum's package is sent",
  };
  return (
    <ol className="ll-stages" aria-label="Lifecycle">
      {STAGES.map((s) => (
        <li key={s} aria-current={s === v.state ? "step" : undefined} className={s === v.state ? "current" : ""}>
          <span className="name">{s}</span> <span className="when tnum">{when[s]}</span>
        </li>
      ))}
    </ol>
  );
}

function VaultView(props: { v: VaultStatus; me: string; epoch: number; personas: Persona[]; latest: RecordEntry | null; onChanged: () => void }) {
  const { v, me, epoch, personas, latest, onChanged } = props;
  // Role-scoped panels are remounted (all local state dropped) when the persona,
  // the vault or the recovery changes, and as soon as a persona switch starts.
  const cardKey = `${me}:${epoch}:${v.vault_id}`;
  const recoveryKey = `${cardKey}:${v.recovery?.recovery_id ?? "none"}`;
  const { busy, error, run } = useAction();
  const isOwner = me === v.owner_id;
  const isTrustee = v.trustee_ids.includes(me);
  const recoveryLive = v.state === "Handover" || v.state === "Released";

  return (
    <>
      <section className="ll-hero" aria-labelledby="vault-h">
        <div className="ll-folio">
          <p className="ll-kicker">{isOwner ? "Your vault" : `Trustee folio · ${personaName(personas, me)}`}</p>
          <h1 id="vault-h">{v.name}</h1>
          <p className="ll-state">
            <span className="chip ll-state-chip" data-testid="lantern-state">{v.state}</span>
          </p>
          <p className="ll-lede">{STATE_LINE[v.state]}</p>
          <LatestLine entry={latest} />

          {isOwner && (
            <div className="ll-action">
              {v.state !== "Released" ? (
                <>
                  <p className="ll-due">
                    <span className="muted small">Next check-in due</span>
                    <time className="tnum">{utcDate(v.next_due_at)}</time>
                  </p>
                  <button className="primary" disabled={busy} onClick={() => run(async () => { await checkIn(api, v.vault_id); onChanged(); })}>
                    Check in: I'm here
                  </button>
                  <p className="small muted">A check-in before release cancels any pending handover. Check-ins are due every {v.cadence_days} days.</p>
                </>
              ) : (
                <p className="small">The package was sent, so a check-in can no longer undo the handover.</p>
              )}
              <ErrorLine error={error} />
            </div>
          )}

          {isTrustee && !recoveryLive && <ShareCard key={cardKey} v={v} me={me} epoch={epoch} personas={personas} onChanged={onChanged} lead />}
          {isTrustee && recoveryLive && <RecoveryPanel key={recoveryKey} v={v} me={me} epoch={epoch} personas={personas} onChanged={onChanged} />}
        </div>

        <div className="ll-lamp">
          <Lantern state={v.state} />
          <StageLedger v={v} />
          <Quorum v={v} me={me} personas={personas} />
        </div>
      </section>

      <section className="ll-letters" aria-labelledby="letters-h">
        <h2 id="letters-h" className="ll-section-title">Sealed letters</h2>
        <ul className="ll-letter-list">
          {v.items.map((i) => (
            <li key={i.item_id} className="ll-letter">
              <span className="seal" aria-hidden="true" />
              <span className="title">{i.label}</span>
              <span className="to small">for {i.deliver_to.join(", ") || "anyone"}</span>
              <span className="when small">
                {i.earliest_release ? <>Held online until <time className="tnum">{i.earliest_release}</time></> : "Opens with the vault"}
              </span>
            </li>
          ))}
        </ul>
        <p className="small muted">
          Names under “for” are routing labels, not separate locks. Earliest release dates are enforced by the online service only.
        </p>
        {isOwner && v.state !== "Released" && <AddItem vaultId={v.vault_id} onChanged={onChanged} />}
      </section>

      {isTrustee && recoveryLive && (
        <section className="ll-letters" aria-label="Share card">
          <ShareCard key={cardKey} v={v} me={me} epoch={epoch} personas={personas} onChanged={onChanged} />
        </section>
      )}

      <p className="ll-footnote small muted">
        A missed check-in is a signal that starts recovery. It does not mean the owner has died. Trustees who rebuild the vault key can open
        the whole vault, and any {v.threshold} of them holding the exported bundle could do that offline at any time.
      </p>
    </>
  );
}

function Quorum({ v, me, personas }: { v: VaultStatus; me: string; personas: Persona[] }) {
  const submitted = v.recovery && v.recovery.state !== "Cancelled" ? v.recovery.submitted_by : [];
  return (
    <div className="ll-quorum">
      <p className="small">
        <strong>Any {v.threshold} of {v.trustee_ids.length}</strong> trustees can open this vault.
      </p>
      <ul aria-label="Trustees">
        {v.trustee_ids.map((t) => (
          <li key={t} className={submitted.includes(t) ? "in" : ""}>
            <span className="dot" aria-hidden="true" />
            {personaName(personas, t)}
            {t === me && <span className="small muted"> (you)</span>}
            {submitted.includes(t) && <span className="visually-hidden"> submitted a share</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function AddItem({ vaultId, onChanged }: { vaultId: string; onChanged: () => void }) {
  const [label, setLabel] = useState("");
  const [to, setTo] = useState("");
  const [date, setDate] = useState("");
  const [body, setBody] = useState("");
  const { busy, error, run } = useAction();
  return (
    <details className="evidence ll-add">
      <summary>Seal a new letter</summary>
      <div className="body">
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
      </div>
    </details>
  );
}

function ShareCard(props: { v: VaultStatus; me: string; epoch: number; personas: Persona[]; onChanged: () => void; lead?: boolean }) {
  const { v, me, epoch, personas, onChanged, lead = false } = props;
  const [card, setCard] = useState<(CardContent & { svg: string; receipt: Receipt }) | null>(null);
  const { busy, error, run } = useAction();
  const live = useLive(epoch);
  useEffect(() => setCard(null), [me]);
  const Heading = "h2";
  return (
    <div className="ll-action" aria-labelledby="card-h">
      <Heading id="card-h" className="ll-subtitle">My share card</Heading>
      <p className="small">
        Your share is stored encrypted to your key. This browser decrypts it and draws the card locally. The QR code and word code never
        leave this page.
      </p>
      {!card && (
        <button
          className={lead ? "primary" : ""}
          disabled={busy}
          onClick={() =>
            run(async () => {
              // After every await: stop if the persona changed or this panel left,
              // so a late response is neither shown nor followed by a request
              // under the next persona's session.
              const c = await myCard(api, ks, me, v.vault_id, live);
              if (!live()) return;
              const svg = await QRCode.toString(c.qr, { type: "svg", errorCorrectionLevel: "M", margin: 1 });
              if (!live()) return;
              const { receipt } = await recordCardIssued(api, v.vault_id);
              if (!live()) return;
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
          <div className="row ll-card-actions">
            <button className="primary" onClick={() => window.print()}>Print card</button>
            <button onClick={() => setCard(null)}>Hide card</button>
          </div>
        </>
      )}
    </div>
  );
}

function RecoveryPanel(props: { v: VaultStatus; me: string; epoch: number; personas: Persona[]; onChanged: () => void }) {
  const { v, me, epoch, personas, onChanged } = props;
  const live = useLive(epoch);
  const r = v.recovery;
  const [typed, setTyped] = useState("");
  const [opened, setOpened] = useState<OpenedRecovery | null>(null);
  const [incomplete, setIncomplete] = useState<RecoveryIncompleteError | null>(null);
  const [haveKey, setHaveKey] = useState(false);
  const { busy, error, run } = useAction();
  useEffect(() => {
    setOpened(null);
    setIncomplete(null);
    if (r) hasRecoveryKey(ks, r.recovery_id).then((k) => { if (live()) setHaveKey(k); });
  }, [r?.recovery_id, me]);

  const submitted = r?.submitted_by.includes(me);
  const isRecoverer = r?.recoverer_id === me;
  return (
    <div className="ll-action" aria-labelledby="recov-h">
      <h2 id="recov-h" className="ll-subtitle">Recovery</h2>
      {!r && v.state === "Handover" && (
        <>
          <p className="small">Open a recovery to receive the other trustees' shares in this browser. They are encrypted to a one-time key made here.</p>
          <button className="primary" disabled={busy} onClick={() => run(async () => { await beginRecovery(api, ks, me, v.vault_id, live); if (live()) onChanged(); })}>
            Open a recovery as {personaName(personas, me)}
          </button>
        </>
      )}
      {r && (
        <>
          <p className="ll-recovery-status">
            <strong>
              Recovery by {personaName(personas, r.recoverer_id)} · {r.state} · shares {r.submitted_by.length} of {v.threshold}
            </strong>
            {r.submitted_by.length > 0 && <span className="small"> ({r.submitted_by.map((t) => personaName(personas, t)).join(", ")})</span>}
          </p>
          {(r.state === "Open" || r.state === "Complete") && !submitted && (
            <div className="ll-sub">
              <h3>{r.state === "Open" ? "Submit my share" : "Add my share to this recovery"}</h3>
              {r.state === "Complete" && (
                <p className="small muted">The package was already sent. Add your share if the recovering trustee could not use one of the others.</p>
              )}
              <button className="primary" disabled={busy} onClick={() => run(async () => { await submitShare(api, ks, me, v, undefined, live); if (live()) onChanged(); })}>
                Use my stored share
              </button>
              <div className="field ll-typed">
                <label htmlFor="typed">Or type the word code (or paste the QR text) from my printed card</label>
                <input id="typed" className="mono" autoComplete="off" spellCheck={false} value={typed} onChange={(e) => setTyped(e.target.value)} />
              </div>
              <button disabled={busy || !typed.trim()} onClick={() => run(async () => { await submitShare(api, ks, me, v, typed, live); if (!live()) return; setTyped(""); onChanged(); })}>
                Submit share from card
              </button>
              <p className="small muted">The code is checked and encrypted in this browser. Only the encrypted envelope is sent.</p>
            </div>
          )}
          {submitted && r.state === "Open" && <p className="small">You submitted your share. Submitting again does not count twice.</p>}
          {isRecoverer && (r.state === "Open" || r.state === "Complete") && (
            <>
              <div className="row">
                <button
                  className="primary"
                  disabled={busy || !haveKey || r.submitted_by.length < v.threshold}
                  onClick={() =>
                    run(async () => {
                      setIncomplete(null);
                      try {
                        const res = await completeRecovery(api, ks, r.recovery_id, live);
                        if (live()) setOpened(res);
                      } catch (e) {
                        if (!live()) return;
                        if (e instanceof RecoveryIncompleteError) setIncomplete(e);
                        else throw e;
                      } finally {
                        onChanged();
                      }
                    })
                  }
                >
                  {r.state === "Complete" ? "Fetch the package again and retry" : "Fetch the package and rebuild the key here"}
                </button>
                {r.submitted_by.length < v.threshold && <span className="small muted">Waiting for {v.threshold - r.submitted_by.length} more.</span>}
                {!haveKey && <span className="small muted">This browser does not hold the recovery key.</span>}
              </div>
              {r.state === "Open" && (
                <p className="small muted">
                  Fetching the package marks the vault Released, because the service has then sent the encrypted shares. This browser checks them
                  afterwards.
                </p>
              )}
            </>
          )}
          {incomplete && (
            <div className="notice danger small" role="alert">
              <strong>The vault key was not rebuilt.</strong>{" "}
              {incomplete.failed.length > 0 && <>The contribution from {incomplete.failed.map((t) => personaName(personas, t)).join(", ")} could not be used here. </>}
              {incomplete.usable} usable of {incomplete.needed} needed. Ask another trustee to add their share to this recovery, then retry. Trustees can
              also recover offline from printed cards and the bundle.
            </div>
          )}
          <details className="ll-tech small">
            <summary>Recovery key fingerprint</summary>
            <code className="wrap-anywhere">{r.fingerprint.slice(0, 32).match(/.{4}/g)!.join(" ")}</code>
          </details>
        </>
      )}
      <ErrorLine error={error} />
      {opened && (
        <div className="stack ll-opened">
          <p className="notice ok small" role="status">
            Vault key rebuilt and verified in this browser (header check passed) from the shares of {opened.used.map((t) => personaName(personas, t)).join(", ")}.
            {opened.failed.length > 0 && <> Not used: {opened.failed.map((t) => personaName(personas, t)).join(", ")}.</>}
          </p>
          {opened.items.map((it) => (
            <article className="ll-opened-letter" key={it.itemId}>
              <div className="spread">
                <h3>{it.label}</h3>
                <span className="small muted">for {it.deliverTo.join(", ") || "anyone"}</span>
              </div>
              {it.withheld ? (
                <p className="notice small">Held online until {it.earliestRelease}. This date is online policy only.</p>
              ) : (
                <div className="secret ll-letter-body">{it.body}</div>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function BundlePanel({ v }: { v: VaultStatus }) {
  const { busy, error, run } = useAction();
  return (
    <section aria-labelledby="bundle-h">
      <h3 id="bundle-h">Offline bundle</h3>
      <p className="small">
        The bundle holds ciphertext and the record snapshot, no shares or keys. With it and any {v.threshold} shares, the offline tool opens
        the vault without this service:
      </p>
      <pre className="small mono wrap-anywhere ll-cmd">node core-ts/bin/recover.js bundle.json</pre>
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
