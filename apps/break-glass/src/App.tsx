// Break Glass: one emergency credential, released to one requester, after a
// quorum of approvers agrees on that same petition.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Api } from "@coven/ui-kit/api.ts";
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
import { Badge, clock, ErrorLine, MailViewer, personaName, RecordVerifier, Shell, useAction, usePersonas } from "@coven/ui-kit/components.tsx";
import type { Receipt } from "@coven/core-ts/records";
import { ApiError } from "@coven/ui-kit/api.ts";

const api = new Api({ app: "break-glass" });
const ks = new IndexedDbKeyStore("coven-break-glass");

const STATE_TONE: Record<PetitionStatus["state"], "ok" | "warn" | "danger" | "info" | "accent"> = {
  Open: "info",
  Approved: "accent",
  Released: "ok",
  Expired: "danger",
  Denied: "danger",
  Invalidated: "danger",
};

function short(fp: string) {
  return fp.slice(0, 32).match(/.{4}/g)!.join(" ");
}

function remaining(expires: string, now: string) {
  const s = Math.floor((Date.parse(expires) - Date.parse(now)) / 1000);
  if (s <= 0) return "ended";
  return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60}s left` : `${s}s left`;
}

export function App() {
  const { personas, me, switchTo } = usePersonas(api, "break-glass", "user:robin");
  const [items, setItems] = useState<BgItem[]>([]);
  const [petitions, setPetitions] = useState<PetitionStatus[]>([]);
  const [localKeys, setLocalKeys] = useState<Record<string, boolean>>({});
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [now, setNow] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [released, setReleased] = useState<null | Released>(null);
  const [loaded, setLoaded] = useState(false);
  const [linkId, setLinkId] = useState<string | null>(() => petitionIdFromHash(window.location.hash));
  const { busy, error, run } = useAction();

  useEffect(() => {
    const onHash = () => setLinkId(petitionIdFromHash(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

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

  const onPersona = async (id: string) => {
    setReleased(null);
    await switchTo(id);
  };

  const isAdmin = me === ADMIN;
  const isApprover = me !== null && APPROVERS.includes(me);

  return (
    <Shell
      api={api}
      ks={ks}
      title="🔨 Break Glass"
      tagline="Emergency credentials, released one item at a time when enough approvers agree."
      personas={personas}
      me={me}
      onPersona={onPersona}
      serverNow={now}
      onChanged={refresh}
      clockSteps={[clock.minutes(5), clock.minutes(30)]}
    >
      <div className="grid">
        <main>
          {loaded && items.length === 0 && <Setup onDone={refresh} />}
          {linkId && me && (
            <LinkView
              pid={linkId}
              me={me}
              personas={personas}
              tick={tick}
              onReleased={(r) => {
                setReleased(r);
                refresh();
              }}
              onClose={() => {
                history.replaceState(null, "", window.location.pathname);
                setLinkId(null);
              }}
            />
          )}
          {released && (
            <ReleasedView
              released={released}
              item={items.find((i) => i.item_id === released.itemId)}
              onRotated={() => run(async () => { await confirmRotation(api, released.itemId); refresh(); })}
              onClose={() => setReleased(null)}
            />
          )}
          {items.length > 0 && me && (
            <ItemsCard items={items} me={me} isAdmin={isAdmin} personas={personas} onChanged={refresh} />
          )}
          {items.length > 0 && (
            <section className="card" aria-labelledby="pet-h">
              <div className="spread">
                <h2 id="pet-h">Petitions</h2>
                <button onClick={refresh}>Refresh</button>
              </div>
              <ErrorLine error={error} />
              {petitions.length === 0 && <p className="muted small">No petitions visible to {personaName(personas, me ?? "")}.</p>}
              {petitions.map((p) => {
                const eligible = me !== null && p.eligible_approvers.includes(me);
                const mine = p.requester_id === me;
                const approvedByMe = me !== null && p.approved_by.includes(me);
                return (
                  <article className="card sub" key={p.petition_id} aria-label={`Petition for ${p.item_name}`}>
                    <div className="spread">
                      <h3>{p.item_name}</h3>
                      <Badge tone={STATE_TONE[p.state]}>{p.state}</Badge>
                    </div>
                    <p className="small">
                      <strong>{personaName(personas, p.requester_id)}</strong> asks: “{p.reason}”
                    </p>
                    <p className="small">
                      Approvals {p.approvals} of {p.threshold} needed
                      {p.approved_by.length > 0 && <> · by {p.approved_by.map((a) => personaName(personas, a)).join(", ")}</>}
                      {p.self_approved && <> · <Badge tone="warn">includes a self-approval</Badge></>}
                    </p>
                    <p className="small muted">
                      Requester key fingerprint <code>{short(p.fingerprint)}</code> · seal version <code>{p.seal_version_id.slice(0, 8)}</code>
                      {!p.seal_version_current && <> (superseded)</>} · link ends {p.expires_at} ({remaining(p.expires_at, p.server_now)})
                    </p>
                    <div className="row">
                      {eligible && p.state === "Open" && !approvedByMe && (
                        <>
                          <button
                            className="primary"
                            disabled={busy}
                            onClick={() => run(async () => { await approvePetition(api, ks, me!, p.petition_id); refresh(); })}
                          >
                            Approve: encrypt my share to this requester key
                          </button>
                          <button className="danger" disabled={busy} onClick={() => run(async () => { await denyPetition(api, p.petition_id); refresh(); })}>
                            Deny
                          </button>
                        </>
                      )}
                      {eligible && approvedByMe && p.state === "Open" && <span className="small muted">You approved. Another approval from you does not count.</span>}
                      {isAdmin && !eligible && (p.state === "Open" || p.state === "Approved") && (
                        <button className="danger" disabled={busy} onClick={() => run(async () => { await denyPetition(api, p.petition_id); refresh(); })}>
                          Deny as item admin
                        </button>
                      )}
                      {mine && (p.state === "Approved" || p.state === "Released") && localKeys[p.petition_id] && (
                        <button
                          className="primary"
                          disabled={busy}
                          onClick={() =>
                            run(async () => {
                              const r = await retrieve(api, ks, p.petition_id);
                              setReleased({ petitionId: p.petition_id, itemId: p.item_id, secret: r.secret, notice: r.notice });
                              refresh();
                            })
                          }
                        >
                          Retrieve and decrypt in this browser
                        </button>
                      )}
                      {mine && p.state === "Open" && <span className="small muted">Waiting for approvals. Nothing is released before quorum.</span>}
                      {mine && p.state === "Released" && !localKeys[p.petition_id] && (
                        <span className="small muted">Opened in this browser; the petition key was deleted after decryption.</span>
                      )}
                    </div>
                    {mine && <p className="small muted">{p.retrieval_notice}</p>}
                    {mine && (
                      <p className="small">
                        <a href={petitionLink(window.location.origin, window.location.pathname, p.petition_id)}>Petition link</a>{" "}
                        <span className="muted">(contains only the petition ID; it works only for you while you are signed in)</span>
                      </p>
                    )}
                  </article>
                );
              })}
            </section>
          )}
          {isApprover && <p className="small muted">You approve as {personaName(personas, me!)}. Your share for each item is encrypted to your key; this browser decrypts it only to re-encrypt it for the requester.</p>}
        </main>
        <aside>
          {me && <MailViewer api={api} refreshKey={`${me}-${tick}`} />}
          <RecordVerifier api={api} chain="bg" current={receipt} />
        </aside>
      </div>
    </Shell>
  );
}

function Setup({ onDone }: { onDone: () => void }) {
  const [log, setLog] = useState<string[]>([]);
  const { busy, error, run } = useAction();
  return (
    <section className="card" aria-labelledby="setup-h">
      <h2 id="setup-h">Set up the fictional team</h2>
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

function ItemsCard(props: { items: BgItem[]; me: string; isAdmin: boolean; personas: { id: string; name: string }[]; onChanged: () => void }) {
  const { items, me, isAdmin, onChanged } = props;
  const [itemId, setItemId] = useState(items[0]?.item_id ?? "");
  const [reason, setReason] = useState("");
  const [windowMin, setWindowMin] = useState(15);
  const [resealFor, setResealFor] = useState<string | null>(null);
  const [newSecret, setNewSecret] = useState("");
  const { busy, error, run } = useAction();
  const names = useMemo(() => new Map(props.personas.map((p) => [p.id, p.name])), [props.personas]);
  return (
    <section className="card" aria-labelledby="items-h">
      <h2 id="items-h">Sealed items</h2>
      <table>
        <thead>
          <tr>
            <th>Item</th>
            <th>Quorum</th>
            <th>Seal version</th>
            <th>Rotation</th>
            {isAdmin && <th />}
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.item_id}>
              <td>{i.name}</td>
              <td className="small">
                {i.threshold} of {i.approver_ids.length}: {i.approver_ids.map((a) => names.get(a) ?? a).join(", ")}
              </td>
              <td className="small mono">{i.seal_version_id?.slice(0, 8)}</td>
              <td>
                {i.rotation_state === "rotation_required" ? (
                  <Badge tone="warn">rotation required</Badge>
                ) : i.rotation_state === "rotated" ? (
                  <Badge tone="ok">rotated</Badge>
                ) : (
                  <span className="small muted">none</span>
                )}
              </td>
              {isAdmin && (
                <td>
                  <button onClick={() => setResealFor(i.item_id)}>Reseal</button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {isAdmin && resealFor && (
        <div className="card sub" style={{ marginTop: "1rem" }}>
          <h3>Reseal {resealFor} with a new value</h3>
          <p className="small muted">
            The browser generates a fresh key and a fresh 2-of-4 share set. Open petitions for the old version are invalidated. Old shares and
            keys cannot open the new version.
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

      {!isAdmin && (
        <div className="card sub" style={{ marginTop: "1rem" }}>
          <h3>Open a petition</h3>
          <div className="row">
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
          <button
            className="primary"
            disabled={busy || !reason.trim()}
            onClick={() =>
              run(async () => {
                await openPetition(api, ks, me, itemId, reason, windowMin * 60);
                setReason("");
                onChanged();
              })
            }
          >
            Open petition
          </button>
          <p className="small muted">This browser makes a one-time key pair for the petition. Approvers encrypt their shares to its public key.</p>
          <ErrorLine error={error} />
        </div>
      )}
      {isAdmin && <ErrorLine error={error} />}
    </section>
  );
}

function ReleasedView(props: {
  released: { petitionId: string; itemId: string; secret: string; notice: string };
  item: BgItem | undefined;
  onRotated: () => void;
  onClose: () => void;
}) {
  const { released, item } = props;
  const [copied, setCopied] = useState(false);
  return (
    <section className="card" aria-labelledby="rel-h" style={{ borderColor: "var(--accent)" }}>
      <div className="spread">
        <h2 id="rel-h">Released: {item?.name ?? released.itemId}</h2>
        <button onClick={props.onClose}>Hide</button>
      </div>
      <p className="small muted">Rebuilt from the approvers' shares and decrypted in this browser. Only this item's key was rebuilt.</p>
      <div className="secret">{released.secret}</div>
      <div className="row" style={{ marginTop: "0.5rem" }}>
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
          <div style={{ marginTop: "0.4rem" }}>
            <button onClick={props.onRotated}>I rotated it in the issuing system</button>
          </div>
        </div>
      )}
      {item?.rotation_state === "rotated" && <p className="notice ok small">Rotation recorded. Reseal the item with the new value.</p>}
    </section>
  );
}

type Released = { petitionId: string; itemId: string; secret: string; notice: string };

/** Opened from a petition link. Every retrieval is decided by the service for the signed-in user. */
function LinkView(props: {
  pid: string;
  me: string;
  personas: { id: string; name: string; app: string; role: string }[];
  tick: number;
  onReleased: (r: Released) => void;
  onClose: () => void;
}) {
  const { pid, me, personas } = props;
  const [status, setStatus] = useState<PetitionStatus | null>(null);
  const [missing, setMissing] = useState(false);
  const [haveKey, setHaveKey] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const [n, setN] = useState(0);

  useEffect(() => setRefused(null), [pid, me]);

  useEffect(() => {
    setMissing(false);
    petition(api, pid).then(setStatus, (e) => {
      setStatus(null);
      if (e instanceof ApiError && e.status === 404) setMissing(true);
    });
    hasLocalKey(ks, pid).then(setHaveKey);
  }, [pid, me, props.tick, n]);

  return (
    <section className="card" aria-labelledby="link-h" style={{ borderColor: "var(--info)" }}>
      <div className="spread">
        <h2 id="link-h">Petition link</h2>
        <button onClick={props.onClose}>Close</button>
      </div>
      {missing && <p role="status">This petition is not available to {personaName(personas, me)}. Nothing is released through this link.</p>}
      {status && (
        <>
          <p>
            {status.item_name} · requested by {personaName(personas, status.requester_id)} · <Badge tone={STATE_TONE[status.state]}>{status.state}</Badge>
          </p>
          <p className="small muted">
            Link ends {status.expires_at} ({remaining(status.expires_at, status.server_now)}) · approvals {status.approvals} of {status.threshold}
          </p>
          {status.state === "Expired" && (
            <p className="notice danger small">This link stopped working at {status.expires_at}. A new release needs a new petition.</p>
          )}
          <p className="small">{status.retrieval_notice}</p>
        </>
      )}
      {status && status.requester_id === me && haveKey && (
        <button
          className="primary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              try {
                const r = await retrieve(api, ks, pid);
                props.onReleased({ petitionId: pid, itemId: status.item_id, secret: r.secret, notice: r.notice });
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
            })
          }
        >
          Retrieve and decrypt in this browser
        </button>
      )}
      {status && status.requester_id === me && !haveKey && !refused && (
        <p className="small muted">This browser does not hold this petition's key (it was used or removed).</p>
      )}
      {refused && (
        <p className="notice danger small" role="alert">
          {refused}
        </p>
      )}
      <ErrorLine error={error} />
    </section>
  );
}
