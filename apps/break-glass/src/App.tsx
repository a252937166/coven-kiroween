// Break Glass: an incident dispatch desk. One sealed credential, released to
// one requester, after a quorum of approvers agrees on that same petition.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Api, ApiError } from "@coven/ui-kit/api.ts";
import { IndexedDbKeyStore } from "@coven/ui-kit/keystore.ts";
import {
  ADMIN,
  APPROVERS,
  approvePetition,
  confirmRotation,
  denyPetition,
  forgetIfTerminal,
  hasLocalKey,
  listItems,
  listPetitions,
  openPetition,
  petition,
  petitionIdFromHash,
  petitionLink,
  retrieve,
  sealItem,
  setupDemo,
  type BgItem,
  type PetitionStatus,
} from "@coven/ui-kit/breakglass.ts";
import {
  clock,
  CovenMark,
  DemoClock,
  ErrorLine,
  MailViewer,
  personaName,
  personaRole,
  RecordVerifier,
  RoleSwitch,
  useAction,
  useLatestRecord,
  usePersonas,
  utc,
  type Tone,
} from "@coven/ui-kit/components.tsx";
import type { Persona } from "@coven/ui-kit/common.ts";
import type { Receipt, RecordEntry } from "@coven/core-ts/records";

const api = new Api({ app: "break-glass" });
const ks = new IndexedDbKeyStore("coven-break-glass");

type State = PetitionStatus["state"];
type Released = { petitionId: string; itemId: string; secret: string; notice: string };

const STATE: Record<State, { label: string; tone: Tone; solid?: boolean; line: string }> = {
  Open: { label: "Awaiting quorum", tone: "info", line: "Blocked until enough distinct approvers agree. Nothing is released before quorum." },
  Approved: { label: "Approved", tone: "ok", line: "Quorum reached. Only the requester can retrieve, in their own browser, before the link ends." },
  Released: { label: "Released", tone: "ok", solid: true, line: "The requester retrieved the credential. Rotate it where it was issued." },
  Expired: { label: "Expired", tone: "danger", line: "The retrieval window ended. The service will not serve this petition again." },
  Denied: { label: "Denied", tone: "danger", solid: true, line: "An approver or the item admin denied this petition. It is closed." },
  Invalidated: { label: "Invalidated", tone: "quiet", line: "The item was resealed. Petitions for the old version are closed." },
};

const EVENT: Record<string, string> = {
  "item.created": "An item was created",
  "seal.activated": "A credential version was sealed",
  "petition.opened": "A petition was opened",
  "petition.approved_by": "An approver approved",
  "petition.quorum": "A petition reached quorum",
  "petition.released": "A credential was released to its requester",
  "rotation.required": "Rotation became required",
  "rotation.confirmed": "Rotation was confirmed",
  "petition.denied": "A petition was denied",
  "petition.expired": "A petition expired",
  "petition.invalidated": "A petition was invalidated by a reseal",
  "petition.retrieved_again": "A requester retrieved again",
};

function StateChip({ s }: { s: State }) {
  const m = STATE[s];
  return (
    <span className={`chip ${m.tone}${m.solid ? " solid" : ""}`} data-testid="petition-state">
      {m.label}
    </span>
  );
}

function short(fp: string) {
  return fp.slice(0, 32).match(/.{4}/g)!.join(" ");
}

function hms(iso: string) {
  return iso.slice(11, 19);
}

function remaining(expires: string, now: string) {
  const s = Math.floor((Date.parse(expires) - Date.parse(now)) / 1000);
  if (s <= 0) return "ended";
  return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s left` : `${s} s left`;
}

export function App() {
  const { personas, me, switchTo } = usePersonas(api, "break-glass", "user:robin");
  const [items, setItems] = useState<BgItem[]>([]);
  const [petitions, setPetitions] = useState<PetitionStatus[]>([]);
  const [localKeys, setLocalKeys] = useState<Record<string, boolean>>({});
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [now, setNow] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [released, setReleased] = useState<Released | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [linkId, setLinkId] = useState<string | null>(() => petitionIdFromHash(window.location.hash));
  const [selected, setSelected] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const latest = useLatestRecord(api, me ? "bg" : null, `${tick}-${me}`);

  useEffect(() => {
    const onHash = () => setLinkId(petitionIdFromHash(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    if (!me) return;
    (async () => {
      const [its, ps, rec, clk] = await Promise.all([
        listItems(api),
        listPetitions(api),
        api.get<{ receipt: Receipt }>("/api/records/bg"),
        api.get<{ server_now: string }>("/api/demo/clock"),
      ]);
      setItems(its);
      setPetitions(ps);
      setReceipt(rec.receipt);
      setNow(clk.server_now);
      const lk: Record<string, boolean> = {};
      for (const p of ps) {
        if (p.requester_id === me) {
          // The petition opened by link keeps its key until the service itself
          // refuses retrieval (410), so a reused link is tested end to end.
          if (p.petition_id !== linkId) await forgetIfTerminal(ks, p);
          lk[p.petition_id] = await hasLocalKey(ks, p.petition_id);
        }
      }
      setLocalKeys(lk);
      setLoaded(true);
    })().catch(() => setLoaded(true));
  }, [me, tick, linkId]);

  // Default selection: the linked petition, else the newest one this role can act on, else the newest.
  const actionable = useCallback(
    (p: PetitionStatus) =>
      (p.state === "Open" && me !== null && p.eligible_approvers.includes(me) && !p.approved_by.includes(me)) ||
      (p.requester_id === me && (p.state === "Approved" || p.state === "Released") && localKeys[p.petition_id]),
    [me, localKeys],
  );
  const current = linkId ?? (selected && petitions.some((p) => p.petition_id === selected) ? selected : null) ??
    petitions.find(actionable)?.petition_id ?? petitions[0]?.petition_id ?? null;

  const onPersona = async (id: string) => {
    setReleased(null);
    setSelected(null);
    setComposing(false);
    await switchTo(id);
  };

  const select = (pid: string) => {
    if (linkId && linkId !== pid) {
      history.replaceState(null, "", window.location.pathname);
      setLinkId(null);
    }
    setSelected(pid);
    setComposing(false);
  };

  const isAdmin = me === ADMIN;

  return (
    <div className="bg-app">
      <a className="skip" href="#desk">Skip to desk</a>
      <aside className="bg-rail" aria-label="Break Glass">
        <div className="bg-brand">
          <CovenMark />
          <span className="bg-wordmark">Break Glass</span>
          <span className="bg-tagline">Incident credential desk</span>
        </div>
        <RoleSwitch personas={personas} me={me} onPersona={onPersona} />
        {me && <p className="bg-role small">{personaRole(personas, me)}</p>}
        <nav aria-label="Sections" className="bg-nav">
          <a href="#desk">Requests</a>
          <a href="#items-h">Sealed items</a>
          <a href="#proof-h">Proof and mail</a>
        </nav>
        <DemoClock api={api} ks={ks} serverNow={now} steps={[clock.minutes(5), clock.minutes(30)]} onChanged={refresh} />
      </aside>

      <main className="bg-main" id="desk">
        {loaded && items.length === 0 && <Setup />}
        {items.length > 0 && me && (
          <>
            <Latest entry={latest} />
            <div className="bg-desk">
              <section className="bg-queue" aria-labelledby="queue-h">
                <div className="spread">
                  <h2 id="queue-h">Request queue</h2>
                  <div className="row">
                    {!isAdmin && (
                      <button className="primary" aria-expanded={composing} onClick={() => setComposing((c) => !c)}>
                        New petition
                      </button>
                    )}
                    <button onClick={refresh}>Refresh</button>
                  </div>
                </div>
                {petitions.length === 0 && <p className="muted small">No petitions visible to {personaName(personas, me)}.</p>}
                <ul className="bg-queue-list">
                  {petitions.map((p) => (
                    <li key={p.petition_id}>
                      <button
                        className={`bg-row${p.petition_id === current && !composing ? " selected" : ""}`}
                        aria-current={p.petition_id === current && !composing ? "true" : undefined}
                        onClick={() => select(p.petition_id)}
                      >
                        <span className="bg-row-top">
                          <span className="bg-row-item">{p.item_name}</span>
                          <StateChip s={p.state} />
                        </span>
                        <span className="bg-row-meta small">
                          {personaName(personas, p.requester_id)} · “{p.reason}”
                        </span>
                        <span className="bg-row-meta small tnum">
                          {p.approvals}/{p.threshold} approvals · ends {hms(p.expires_at)} UTC
                          {actionable(p) && <span className="bg-row-flag"> · your action</span>}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>

              <div className="bg-detail">
                {composing && !isAdmin ? (
                  <NewPetition
                    items={items}
                    me={me}
                    onOpened={(pid) => {
                      setComposing(false);
                      setSelected(pid);
                      refresh();
                    }}
                    onCancel={() => setComposing(false)}
                  />
                ) : current ? (
                  <Ticket
                    key={current}
                    pid={current}
                    fromLink={current === linkId}
                    me={me}
                    personas={personas}
                    items={items}
                    tick={tick}
                    released={released && released.petitionId === current ? released : null}
                    onReleased={(r) => {
                      setReleased(r);
                      refresh();
                    }}
                    onRotated={async (itemId) => {
                      await confirmRotation(api, itemId);
                      refresh();
                    }}
                    onChanged={refresh}
                    onClose={() => {
                      history.replaceState(null, "", window.location.pathname);
                      setLinkId(null);
                    }}
                  />
                ) : (
                  <section className="bg-ticket bg-empty">
                    <p>Select a request, or open a new petition.</p>
                  </section>
                )}
              </div>
            </div>

            <ItemsPanel items={items} isAdmin={isAdmin} personas={personas} onChanged={refresh} />
          </>
        )}

        {me && (
          <section className="bg-proof" aria-labelledby="proof-h">
            <h2 id="proof-h">Proof and mail</h2>
            <div className="bg-proof-grid">
              <details className="evidence">
                <summary>Record and receipts</summary>
                <div className="body">
                  <RecordVerifier api={api} chain="bg" current={receipt} />
                </div>
              </details>
              <details className="evidence">
                <summary>Demo mail</summary>
                <div className="body">
                  <MailViewer api={api} refreshKey={`${me}-${tick}`} />
                </div>
              </details>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

function Latest({ entry }: { entry: RecordEntry | null }) {
  if (!entry) return null;
  return (
    <p className="bg-latest small" role="status">
      <span className="muted">Last recorded</span> {EVENT[entry.type] ?? entry.type} · <time className="tnum">{utc(entry.at)}</time>
    </p>
  );
}

function Setup() {
  const [log, setLog] = useState<string[]>([]);
  const { busy, error, run } = useAction();
  return (
    <section className="bg-ticket bg-setup" aria-labelledby="setup-h">
      <p className="bg-kicker">Desk closed · no credentials sealed</p>
      <h1 id="setup-h">Set up the fictional team</h1>
      <p>
        This creates a key pair in this browser for each persona, enrolls the public keys, and has Quinn seal three fictional credentials.
        Each credential gets its own key, split 2 of 4 among Sage, Rowan, Ash and Wren.
      </p>
      <button className="primary" disabled={busy} onClick={() => run(async () => { await setupDemo(api, ks, (s) => setLog((l) => [...l, s])); window.location.reload(); })}>
        Set up demo
      </button>
      <ErrorLine error={error} />
      {log.length > 0 && <pre className="small muted">{log.join("\n")}</pre>}
    </section>
  );
}

function NewPetition(props: { items: BgItem[]; me: string; onOpened: (pid: string) => void; onCancel: () => void }) {
  const { items, me } = props;
  const [itemId, setItemId] = useState(items[0]?.item_id ?? "");
  const [reason, setReason] = useState("");
  const [windowMin, setWindowMin] = useState(15);
  const { busy, error, run } = useAction();
  return (
    <section className="bg-ticket" aria-labelledby="new-h">
      <p className="bg-kicker">New petition</p>
      <h2 id="new-h">Request one sealed credential</h2>
      <div className="bg-form">
        <div className="field">
          <label htmlFor="pet-item">Item</label>
          <select id="pet-item" value={itemId} onChange={(e) => setItemId(e.target.value)}>
            {items.map((i) => (
              <option key={i.item_id} value={i.item_id}>
                {i.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="pet-window">Retrieval window</label>
          <select id="pet-window" value={windowMin} onChange={(e) => setWindowMin(Number(e.target.value))}>
            {[5, 15, 30, 60].map((m) => (
              <option key={m} value={m}>
                {m} minutes
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor="pet-reason">Reason</label>
        <input id="pet-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Production database locked out" />
      </div>
      <div className="row">
        <button
          className="primary"
          disabled={busy || !reason.trim()}
          onClick={() =>
            run(async () => {
              const s = await openPetition(api, ks, me, itemId, reason, windowMin * 60);
              props.onOpened(s.petition_id);
            })
          }
        >
          Open petition
        </button>
        <button onClick={props.onCancel}>Cancel</button>
      </div>
      <p className="small muted">This browser makes a one-time key pair for the petition. Approvers encrypt their shares to its public key.</p>
      <ErrorLine error={error} />
    </section>
  );
}

function Ticket(props: {
  pid: string;
  fromLink: boolean;
  me: string;
  personas: Persona[];
  items: BgItem[];
  tick: number;
  released: Released | null;
  onReleased: (r: Released) => void;
  onRotated: (itemId: string) => Promise<void>;
  onChanged: () => void;
  onClose: () => void;
}) {
  const { pid, me, personas, fromLink } = props;
  const [p, setP] = useState<PetitionStatus | null>(null);
  const [missing, setMissing] = useState(false);
  const [haveKey, setHaveKey] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [n, setN] = useState(0);
  const { busy, error, run } = useAction();

  useEffect(() => setRefused(null), [pid, me]);
  useEffect(() => {
    setMissing(false);
    petition(api, pid).then(setP, (e) => {
      setP(null);
      if (e instanceof ApiError && e.status === 404) setMissing(true);
    });
    hasLocalKey(ks, pid).then(setHaveKey);
  }, [pid, me, props.tick, n]);

  const item = props.items.find((i) => i.item_id === p?.item_id);
  const eligible = p !== null && p.eligible_approvers.includes(me);
  const mine = p?.requester_id === me;
  const approvedByMe = p !== null && p.approved_by.includes(me);
  const isAdmin = me === ADMIN;
  const name = (id: string) => personaName(personas, id);

  const doRetrieve = () =>
    run(async () => {
      try {
        const r = await retrieve(api, ks, pid);
        props.onReleased({ petitionId: pid, itemId: p!.item_id, secret: r.secret, notice: r.notice });
      } catch (e) {
        if (e instanceof ApiError && (e.status === 410 || e.status === 409 || e.status === 404)) {
          setRefused(
            e.status === 410
              ? `Retrieval refused: the petition is ${String(e.body.state ?? e.code).toLowerCase()}. Nothing was sent; the petition key in this browser was deleted.`
              : "Retrieval refused: the petition has not reached quorum.",
          );
        } else throw e;
      } finally {
        setN((x) => x + 1);
      }
    });

  return (
    <section className="bg-ticket" aria-label={fromLink ? "Petition link" : "Selected petition"}>
      {fromLink && (
        <div className="spread bg-linkbar">
          <span className="small">Opened from a petition link. Access is checked for {name(me)} on every request.</span>
          <button className="link" onClick={props.onClose}>Close link</button>
        </div>
      )}
      {missing && <p role="status" className="bg-missing">This petition is not available to {name(me)}. Nothing is released through this link.</p>}
      {p && (
        <article aria-label={`Petition for ${p.item_name}`}>
          <header className={`bg-strip tone-${STATE[p.state].tone}`}>
            <div className="spread">
              <p className="bg-kicker">Petition · one sealed item</p>
              <span className="row">
                {p.rotation_state === "rotation_required" && <span className="chip warn">Rotation required</span>}
                <StateChip s={p.state} />
              </span>
            </div>
            <h2 className="bg-item-name">{p.item_name}</h2>
            <p className="bg-state-line">{STATE[p.state].line}</p>
          </header>

          <dl className="bg-facts">
            <div>
              <dt>Quorum</dt>
              <dd className="tnum">
                <strong>{p.approvals}</strong> of {p.threshold}
              </dd>
              <dd className="small">Approvals {p.approvals} of {p.threshold} needed</dd>
            </div>
            <div>
              <dt>Link ends (service clock)</dt>
              <dd className="tnum">
                <strong>{hms(p.expires_at)}</strong> UTC
              </dd>
              <dd className="small tnum">{p.expires_at.slice(0, 10)} · {remaining(p.expires_at, p.server_now)}</dd>
            </div>
            <div>
              <dt>Requester</dt>
              <dd>
                <strong>{name(p.requester_id)}</strong>
              </dd>
              <dd className="small">“{p.reason}”</dd>
            </div>
          </dl>

          <div className="bg-approvers">
            <h3>Approvers</h3>
            <ul>
              {p.eligible_approvers.map((a) => (
                <li key={a} className={p.approved_by.includes(a) ? "yes" : ""}>
                  <span className="mark" aria-hidden="true">{p.approved_by.includes(a) ? "✓" : ""}</span>
                  {name(a)}
                  {a === me && <span className="muted"> (you)</span>}
                  <span className="visually-hidden">{p.approved_by.includes(a) ? " approved" : " not yet"}</span>
                </li>
              ))}
            </ul>
            {p.self_approved && <p className="small"><span className="chip warn">includes a self-approval</span></p>}
          </div>

          <div className="bg-actionstrip" aria-label="Your action">
            {eligible && p.state === "Open" && !approvedByMe && (
              <>
                <button className="primary" disabled={busy} onClick={() => run(async () => { await approvePetition(api, ks, me, pid); props.onChanged(); setN((x) => x + 1); })}>
                  Approve: encrypt my share to this requester key
                </button>
                <button className="danger" disabled={busy} onClick={() => run(async () => { await denyPetition(api, pid); props.onChanged(); setN((x) => x + 1); })}>
                  Deny
                </button>
              </>
            )}
            {eligible && approvedByMe && p.state === "Open" && <p className="small">You approved. Another approval from you does not count.</p>}
            {isAdmin && !eligible && (p.state === "Open" || p.state === "Approved") && (
              <button className="danger" disabled={busy} onClick={() => run(async () => { await denyPetition(api, pid); props.onChanged(); setN((x) => x + 1); })}>
                Deny as item admin
              </button>
            )}
            {mine && haveKey && (fromLink || p.state === "Approved" || p.state === "Released") && (
              <button className="primary" disabled={busy} onClick={doRetrieve}>
                Retrieve and decrypt in this browser
              </button>
            )}
            {mine && p.state === "Open" && <p className="small">Waiting for approvals. Nothing is released before quorum.</p>}
            {mine && !haveKey && !refused && p.state === "Released" && (
              <p className="small">Opened in this browser; the petition key was deleted after decryption.</p>
            )}
            {mine && !haveKey && !refused && p.state !== "Released" && p.state !== "Open" && p.state !== "Approved" && (
              <p className="small">This browser does not hold this petition's key (it was used or removed).</p>
            )}
            {!mine && !eligible && !isAdmin && <p className="small muted">No action for your role on this petition.</p>}
            {!mine && eligible && p.state !== "Open" && <p className="small muted">Approvals are closed for this petition.</p>}
          </div>
          {refused && (
            <p className="notice danger small" role="alert">
              {refused}
            </p>
          )}
          <ErrorLine error={error} />

          {p.state === "Expired" && (
            <p className="notice danger small">This link stopped working at {p.expires_at}. A new release needs a new petition.</p>
          )}

          {props.released && (
            <ReleasedView released={props.released} item={item} onRotated={() => run(() => props.onRotated(props.released!.itemId))} />
          )}

          {mine && (
            <div className="bg-linkline small">
              <a href={petitionLink(window.location.origin, window.location.pathname, p.petition_id)}>Petition link</a>{" "}
              <span className="muted">(contains only the petition ID; it works only for you while you are signed in)</span>
            </div>
          )}

          {!props.released && <p className="small bg-notice">{p.retrieval_notice}</p>}

          <details className="bg-tech">
            <summary>Ticket details</summary>
            <dl className="small">
              <div><dt>Requester key fingerprint</dt><dd><code className="wrap-anywhere">{short(p.fingerprint)}</code></dd></div>
              <div><dt>Seal version</dt><dd><code>{p.seal_version_id.slice(0, 8)}</code>{!p.seal_version_current && " (superseded)"}</dd></div>
              <div><dt>Petition</dt><dd><code className="wrap-anywhere">{p.petition_id}</code></dd></div>
              <div><dt>Opened</dt><dd className="tnum">{utc(p.created_at)}</dd></div>
            </dl>
          </details>
        </article>
      )}
    </section>
  );
}

function ItemsPanel(props: { items: BgItem[]; isAdmin: boolean; personas: Persona[]; onChanged: () => void }) {
  const { items, isAdmin, onChanged } = props;
  const [resealFor, setResealFor] = useState<string | null>(null);
  const [newSecret, setNewSecret] = useState("");
  const { busy, error, run } = useAction();
  const names = useMemo(() => new Map(props.personas.map((p) => [p.id, p.name])), [props.personas]);
  return (
    <section className="bg-items" aria-labelledby="items-h">
      <h2 id="items-h">Sealed items</h2>
      <ul className="bg-item-list">
        {items.map((i) => (
          <li key={i.item_id} className="bg-item">
            <span className="bg-item-title">{i.name}</span>
            <span className="small">
              {i.threshold} of {i.approver_ids.length}: {i.approver_ids.map((a) => names.get(a) ?? a).join(", ")}
            </span>
            <span className="small">
              version <code>{i.seal_version_id?.slice(0, 8)}</code>
            </span>
            <span data-testid={`rotation-${i.item_id}`}>
              {i.rotation_state === "rotation_required" ? (
                <span className="chip warn">rotation required</span>
              ) : i.rotation_state === "rotated" ? (
                <span className="chip ok">rotated</span>
              ) : (
                <span className="small muted">no rotation pending</span>
              )}
            </span>
            {isAdmin && (
              <span>
                <button onClick={() => setResealFor(i.item_id)}>Reseal</button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {isAdmin && resealFor && (
        <div className="bg-reseal">
          <h3>Reseal {resealFor} with a new value</h3>
          <p className="small muted">
            The browser generates a fresh key and a fresh 2-of-4 share set. Open petitions for the old version are invalidated. Old shares and keys
            cannot open the new version.
          </p>
          <div className="field">
            <label htmlFor="new-secret">New credential (fictional)</label>
            <textarea id="new-secret" value={newSecret} onChange={(e) => setNewSecret(e.target.value)} />
          </div>
          <div className="row">
            <button
              className="primary"
              disabled={busy || !newSecret}
              onClick={() =>
                run(async () => {
                  await sealItem(api, resealFor, newSecret, APPROVERS, 2);
                  setNewSecret("");
                  setResealFor(null);
                  onChanged();
                })
              }
            >
              Seal new version
            </button>
            <button onClick={() => setResealFor(null)}>Cancel</button>
          </div>
        </div>
      )}
      <ErrorLine error={error} />
    </section>
  );
}

function ReleasedView(props: { released: Released; item: BgItem | undefined; onRotated: () => void }) {
  const { released, item } = props;
  const [copied, setCopied] = useState(false);
  return (
    <div className="bg-released" aria-labelledby="rel-h">
      <h3 id="rel-h">Released to you: {item?.name ?? released.itemId}</h3>
      <p className="small">Rebuilt from the approvers' shares and decrypted in this browser. Only this item's key was rebuilt.</p>
      <div className="secret">{released.secret}</div>
      <div className="row bg-copy">
        <button
          onClick={async () => {
            await navigator.clipboard.writeText(released.secret);
            setCopied(true);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="notice">{released.notice}</p>
      {item?.rotation_state === "rotation_required" && (
        <div className="notice danger">
          <strong>Rotation required.</strong> After the incident, rotate this credential where it was issued, then record it here.
          <div className="bg-copy">
            <button onClick={props.onRotated}>I rotated it in the issuing system</button>
          </div>
        </div>
      )}
      {item?.rotation_state === "rotated" && <p className="notice ok small">Rotation recorded. Reseal the item with the new value.</p>}
    </div>
  );
}
