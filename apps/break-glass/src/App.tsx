// Break Glass: an incident dispatch desk. One sealed credential, released to
// one requester, after a quorum of approvers agrees on that same petition.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Api, ApiError } from "@coven/ui-kit/api.ts";
import { IndexedDbKeyStore } from "@coven/ui-kit/keystore.ts";
import {
  ADMIN,
  APPROVERS,
  approvePetition,
  confirmRotation,
  demoProgress,
  denyPetition,
  forgetIfTerminal,
  hasLocalKey,
  listItems,
  listPetitions,
  openedHere,
  openPetition,
  petition,
  petitionIdFromHash,
  petitionLink,
  reconcilePetitions,
  retrieve,
  sealItem,
  setupDemo,
  type BgItem,
  type PetitionStatus,
} from "@coven/ui-kit/breakglass.ts";
import {
  clock,
  currentEpoch,
  CovenMark,
  DemoClock,
  ErrorLine,
  errorText,
  isCurrentEpoch,
  Loading,
  LoadProblem,
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
import { StaleFlowError, type Persona } from "@coven/ui-kit/common.ts";
import { useEntrance, useFlash, useNewlyAdded, useServerClock } from "@coven/ui-kit/motion.ts";
import type { Receipt, RecordEntry } from "@coven/core-ts/records";
import { Relay, type RelayMode } from "./Instrument.tsx";

const NONE: ReadonlySet<number> = new Set();
const MODE: Record<PetitionStatus["state"], RelayMode> = {
  Open: "open",
  Approved: "approved",
  Released: "released",
  Expired: "expired",
  Denied: "denied",
  Invalidated: "invalidated",
};

const api = new Api({ app: "break-glass" });
const ks = new IndexedDbKeyStore("coven-break-glass");

type State = PetitionStatus["state"];
/** Plaintext bound to the persona who decrypted it, the ticket and the role epoch. */
type Released = { petitionId: string; itemId: string; secret: string; notice: string; viewer: string; epoch: number };

/** True while mounted and the persona has not changed since `epoch`. */
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

const STATE: Record<State, { label: string; tone: Tone; solid?: boolean; line: string }> = {
  Open: { label: "Awaiting quorum", tone: "info", line: "Blocked until enough distinct approvers agree. Nothing is released before quorum." },
  Approved: { label: "Approved", tone: "ok", line: "Quorum reached. Only the requester can retrieve, in their own browser, before the link ends." },
  Released: {
    label: "Released",
    tone: "ok",
    solid: true,
    line: "The service sent the encrypted package to the requester. It opens only in the requester's browser. Rotate the credential where it was issued.",
  },
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
  const { personas, me, switchTo, epoch, pending, runSignedInFlow, sessionError, retrySession } = usePersonas(api, "break-glass", "user:robin");
  const [items, setItems] = useState<BgItem[]>([]);
  const [petitions, setPetitions] = useState<PetitionStatus[]>([]);
  const [localKeys, setLocalKeys] = useState<Record<string, boolean>>({});
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [now, setNow] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [released, setReleased] = useState<Released | null>(null);
  const [loaded, setLoaded] = useState(false); // at least one complete, verified load
  const [loadError, setLoadError] = useState<string | null>(null);
  const [linkId, setLinkId] = useState<string | null>(() => petitionIdFromHash(window.location.hash));
  const [selected, setSelected] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [dataFor, setDataFor] = useState<string | null>(null); // `${persona}:${epoch}` the queue was loaded for

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const latest = useLatestRecord(api, me ? "bg" : null, `${tick}-${me}`);

  useEffect(() => {
    const onHash = () => setLinkId(petitionIdFromHash(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    if (!me || pending) return; // never load role-scoped data while the session is changing
    let stale = false;
    const e = currentEpoch();
    const live = () => !stale && isCurrentEpoch(e);
    // If a request never answers, say so with a retry instead of waiting silently.
    const slow = window.setTimeout(() => {
      if (live()) setLoadError("the service has not answered for 12 seconds");
    }, 12_000);
    (async () => {
      const [its, ps, rec, clk] = await Promise.all([
        listItems(api),
        listPetitions(api),
        api.get<{ receipt: Receipt }>("/api/records/bg"),
        api.get<{ server_now: string }>("/api/demo/clock"),
      ]);
      if (!live()) return; // a response for an earlier persona or refresh
      // A petition whose creation answer was lost is adopted by its one-time key.
      await reconcilePetitions(ks, me, ps).catch(() => []);
      const lk: Record<string, boolean> = {};
      for (const p of ps) {
        if (p.requester_id === me) {
          // The petition opened by link keeps its key until the service itself
          // refuses retrieval (410), so a reused link is tested end to end.
          if (p.petition_id !== linkId) await forgetIfTerminal(ks, p);
          lk[p.petition_id] = await hasLocalKey(ks, p.petition_id);
        }
      }
      if (!live()) return;
      setItems(its);
      setPetitions(ps);
      setReceipt(rec.receipt);
      setNow(clk.server_now);
      setLocalKeys(lk);
      setDataFor(`${me}:${e}`);
      setLoadError(null);
      setLoaded(true);
    })()
      .catch((err) => {
        // Never shown as an empty desk: the failure stays visible with a retry.
        if (live()) setLoadError(errorText(err));
      })
      .finally(() => window.clearTimeout(slow));
    return () => {
      stale = true;
      window.clearTimeout(slow);
    };
  }, [me, epoch, pending, tick, linkId]);

  // Default selection: the linked petition, else the newest one this role can act on, else the newest.
  const actionable = useCallback(
    (p: PetitionStatus) =>
      (p.state === "Open" && me !== null && p.eligible_approvers.includes(me) && !p.approved_by.includes(me)) ||
      (p.requester_id === me && (p.state === "Approved" || p.state === "Released") && localKeys[p.petition_id]),
    [me, localKeys],
  );
  const current = linkId ?? (selected && petitions.some((p) => p.petition_id === selected) ? selected : null) ??
    petitions.find(actionable)?.petition_id ?? petitions[0]?.petition_id ?? null;

  // Pin the automatically chosen ticket, so acting on it (approve, retrieve)
  // does not make the desk jump to a different petition.
  const fresh = !pending && dataFor === `${me}:${epoch}`;
  useEffect(() => {
    if (fresh && !selected && !linkId && current) setSelected(current);
  }, [fresh, selected, linkId, current]);

  const onPersona = async (id: string) => {
    // switchTo bumps the role epoch first, so any pending retrieval or approval
    // started by the previous persona is discarded when it resolves.
    setReleased(null);
    setSelected(null);
    setComposing(false);
    await switchTo(id);
  };

  const clearLink = () => {
    if (window.location.hash) history.replaceState(null, "", window.location.pathname);
    setLinkId(null);
  };

  const select = (pid: string) => {
    if (linkId && linkId !== pid) clearLink();
    if (pid !== current) setReleased(null); // leaving a ticket drops its plaintext
    setSelected(pid);
    setComposing(false);
  };

  const acceptReleased = (r: Released) => {
    if (r.viewer !== me || !isCurrentEpoch(r.epoch)) return; // late result for another persona
    setReleased(r);
    refresh();
  };

  const shownReleased =
    released && released.petitionId === current && released.viewer === me && isCurrentEpoch(released.epoch) ? released : null;

  const isAdmin = me === ADMIN;
  const progress = demoProgress(items);
  const entering = useEntrance(loaded, 3200, pending);

  return (
    <div className={`bg-app${entering ? " entering" : ""}`}>
      <a className="skip" href="#desk">Skip to desk</a>
      <header className="bg-top">
        <div className="bg-brand">
          <CovenMark />
          <span className="bg-wordmark">Break Glass</span>
          <span className="bg-tagline">Incident credential desk</span>
        </div>
        <nav aria-label="Sections" className="bg-nav">
          <a href="#desk">Requests</a>
          <a href="#items-h">Sealed items</a>
          <a href="#proof-h">Proof and mail</a>
        </nav>
        {/* While any sign-in is in flight, demo controls and the desk are inert. */}
        <div className="bg-demo" inert={pending}>
          <DemoClock api={api} ks={ks} serverNow={now} steps={[clock.minutes(5), clock.minutes(30)]} onChanged={refresh} />
        </div>
        <div className="bg-who">
          <RoleSwitch personas={personas} me={me} onPersona={onPersona} pending={pending} />
          {me && <p className="bg-role small">{personaRole(personas, me)}</p>}
        </div>
      </header>

      <main className="bg-main" id="desk" inert={pending} aria-busy={pending}>
        {sessionError && <LoadProblem what="your demo session" error={sessionError} onRetry={retrySession} />}
        {!me && !sessionError && <Loading what="the demo session" />}
        {me && loadError && <LoadProblem what={loaded ? "the latest desk data" : "the desk"} error={loadError} onRetry={refresh} stale={loaded} />}
        {me && !loaded && !loadError && <Loading what="the desk" />}
        {me && loaded && !progress.ready && <Setup runSignedInFlow={runSignedInFlow} progress={progress} started={items.length > 0} />}
        {me && loaded && progress.ready && (
          <>
            <Latest entry={latest} />
            {!fresh && !loadError && (
              <p className="small muted" role="status">
                Loading the desk for {personaName(personas, me)}…
              </p>
            )}
            {fresh && (
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
                          <span className={`bg-row-cells${MODE[p.state] === "expired" || MODE[p.state] === "denied" || MODE[p.state] === "invalidated" ? " cut" : ""}`} aria-hidden="true">
                            {Array.from({ length: p.threshold }, (_, i) => (
                              <i key={i} className={i < p.approvals ? "on" : ""} />
                            ))}
                          </span>
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
                    epoch={epoch}
                    onOpened={(pid) => {
                      clearLink(); // a new petition replaces any old link selection
                      setReleased(null);
                      setComposing(false);
                      setSelected(pid);
                      refresh();
                    }}
                    onCancel={() => setComposing(false)}
                  />
                ) : current ? (
                  <Ticket
                    key={`${me}:${epoch}:${current}`}
                    pid={current}
                    fromLink={current === linkId}
                    me={me}
                    epoch={epoch}
                    personas={personas}
                    items={items}
                    tick={tick}
                    released={shownReleased}
                    onReleased={acceptReleased}
                    onHide={() => setReleased(null)}
                    onRotated={async (itemId) => {
                      await confirmRotation(api, itemId);
                      refresh();
                    }}
                    onChanged={refresh}
                    onClose={() => {
                      setReleased(null);
                      clearLink();
                    }}
                  />
                ) : (
                  <section className="bg-ticket bg-empty">
                    <p className="bg-kicker">Workbench · nothing selected</p>
                    <Relay mode="idle" threshold={items[0]?.threshold ?? 2} approvals={0} names={[]} pulse={NONE} windowLeft={null} />
                    <p className="bg-empty-line">Select a request, or open a new petition.</p>
                  </section>
                )}
              </div>
            </div>
            )}

            <ItemsPanel key={`${me}:${epoch}`} items={items} isAdmin={isAdmin} personas={personas} onChanged={refresh} />
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

/**
 * The relay for one loaded petition. Mounted with the petition already loaded,
 * so approvals that were in before this view only pulse when the service
 * confirms a new one.
 */
function RelayPanel({ p, mode, nowMs, personas }: { p: PetitionStatus; mode: RelayMode; nowMs: number | null; personas: Persona[] }) {
  // Seats newly lit for this petition, by its approval count: approver order can
  // tie within one second and then sorts by approver ID.
  const seats = Math.min(p.approvals, p.threshold);
  const arrived = useNewlyAdded(Array.from({ length: seats }, (_, i) => `${p.petition_id}:seat:${i + 1}`), 1900);
  const pulse = new Set<number>();
  for (let i = 1; i <= seats; i++) if (arrived.has(`${p.petition_id}:seat:${i}`)) pulse.add(i);
  // The quorum beat: this same petition crossing its approval threshold while this view is open.
  const latch = useFlash(
    `${p.petition_id}|${p.approvals >= p.threshold ? 1 : 0}`,
    (a, b) => a.split("|")[0] === b.split("|")[0] && a.endsWith("|0") && b.endsWith("|1"),
    1900,
  );
  const created = Date.parse(p.created_at);
  const expires = Date.parse(p.expires_at);
  const now = nowMs ?? Date.parse(p.server_now);
  const timed = p.state === "Open" || p.state === "Approved" || p.state === "Released";
  const windowLeft = timed ? (expires - now) / Math.max(1, expires - created) : p.state === "Expired" ? 0 : null;
  return (
    <Relay
      mode={mode}
      threshold={p.threshold}
      approvals={p.approvals}
      names={p.approved_by.map((a) => personaName(personas, a).split(" ")[0])}
      pulse={pulse}
      latch={latch}
      windowLeft={windowLeft}
      windowText={windowLeft === null ? undefined : `window ${remaining(p.expires_at, new Date(now).toISOString())}`}
    />
  );
}

function Setup(props: { runSignedInFlow: <T>(fn: () => Promise<T>) => Promise<T | undefined>; progress: { sealed: number; total: number }; started: boolean }) {
  const { runSignedInFlow, progress, started } = props;
  const [log, setLog] = useState<string[]>([]);
  const { busy, error, run } = useAction();
  const resume = started;
  return (
    <section className="bg-ticket bg-setup" aria-labelledby="setup-h">
      <Relay mode="idle" threshold={2} approvals={0} names={[]} pulse={NONE} windowLeft={null} />
      <p className="bg-kicker">{resume ? `Setup did not finish · ${progress.sealed} of ${progress.total} sealed` : "Desk closed · no credentials sealed"}</p>
      <h1 id="setup-h">{resume ? "Finish the demo setup" : "Set up the fictional team"}</h1>
      <p>
        {resume
          ? "An earlier setup stopped part way. Running it again keeps what is done: it adds only the missing credentials and never seals one twice."
          : "This creates a key pair in this browser for each persona, enrolls the public keys, and has Quinn seal three fictional credentials. Each credential gets its own key, split 2 of 4 among Sage, Rowan, Ash and Wren."}
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
    </section>
  );
}

function NewPetition(props: { items: BgItem[]; me: string; epoch: number; onOpened: (pid: string) => void; onCancel: () => void }) {
  const { items, me } = props;
  const live = useLive(props.epoch);
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
              const s = await openPetition(api, ks, me, itemId, reason, windowMin * 60, live);
              if (live()) props.onOpened(s.petition_id);
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
  epoch: number;
  personas: Persona[];
  items: BgItem[];
  tick: number;
  released: Released | null;
  onReleased: (r: Released) => void;
  onHide: () => void;
  onRotated: (itemId: string) => Promise<void>;
  onChanged: () => void;
  onClose: () => void;
}) {
  const { pid, me, personas, fromLink } = props;
  const [p, setP] = useState<PetitionStatus | null>(null);
  const [missing, setMissing] = useState(false);
  const [haveKey, setHaveKey] = useState(false);
  const [openedBefore, setOpenedBefore] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  const { busy, error, run } = useAction();
  const live = useLive(props.epoch);

  useEffect(() => setRefused(null), [pid, me]);
  useEffect(() => {
    let stale = false;
    const ok = () => !stale && live();
    setMissing(false);
    (async () => {
      const s = await petition(api, pid);
      if (!ok()) return;
      // A petition whose creation answer was lost is adopted by its one-time key.
      await reconcilePetitions(ks, me, [s]).catch(() => []);
      const k = await hasLocalKey(ks, pid);
      const o = await openedHere(ks, pid);
      if (!ok()) return;
      setP(s);
      setHaveKey(k);
      setOpenedBefore(o);
      setFetchError(null);
    })().catch((e) => {
      if (!ok()) return;
      if (e instanceof ApiError && e.status === 404) {
        setP(null);
        setMissing(true);
        setFetchError(null);
      } else {
        setFetchError(errorText(e)); // the last status stays, marked as possibly out of date
      }
    });
    return () => { stale = true; };
  }, [pid, me, props.tick, n, live]);

  // Display only: the service clock advanced locally between fetches. The service alone decides expiry.
  const nowMs = useServerClock(p?.server_now);
  const nowIso = nowMs !== null ? new Date(nowMs).toISOString() : (p?.server_now ?? "");
  // The aperture opens only when this browser decrypted and verified the item for its own requester,
  // and only while the service still treats the petition as active. A terminal state from the
  // service (Expired, Denied, Invalidated) always closes and cuts the path, even if the value
  // retrieved earlier is still shown on this page.
  const shown =
    p !== null && !!props.released && props.released.viewer === me && p.requester_id === me && props.released.petitionId === p.petition_id;
  const terminal = p !== null && (p.state === "Expired" || p.state === "Denied" || p.state === "Invalidated");
  const opened = shown && !terminal;
  const mode: RelayMode = !p ? "idle" : opened ? "opened" : MODE[p.state];

  const item = props.items.find((i) => i.item_id === p?.item_id);
  const eligible = p !== null && p.eligible_approvers.includes(me);
  const mine = p?.requester_id === me;
  const approvedByMe = p !== null && p.approved_by.includes(me);
  const isAdmin = me === ADMIN;
  const name = (id: string) => personaName(personas, id);
  const releasedHere =
    !!props.released && props.released.viewer === me && p !== null && p.requester_id === me && props.released.petitionId === p.petition_id;
  const wasOpenedHere = openedBefore || releasedHere;

  // When the window ends on the service clock, read the authoritative status once,
  // so the ticket does not stay on Approved with an ended window. A failed read shows a retry.
  const expiryRead = useRef<string | null>(null);
  useEffect(() => {
    if (!p || nowMs === null || !(p.state === "Open" || p.state === "Approved" || p.state === "Released")) return;
    const key = `${p.petition_id}|${p.expires_at}`;
    if (nowMs >= Date.parse(p.expires_at) && expiryRead.current !== key) {
      expiryRead.current = key;
      setN((x) => x + 1);
    }
  }, [nowMs, p]);

  const doRetrieve = () =>
    run(async () => {
      const viewer = me;
      const epoch = props.epoch;
      try {
        const r = await retrieve(api, ks, pid, live);
        if (!live()) return; // persona changed while the package was in flight: discard
        props.onReleased({ petitionId: pid, itemId: p!.item_id, secret: r.secret, notice: r.notice, viewer, epoch });
      } catch (e) {
        if (e instanceof StaleFlowError || !live()) return;
        if (e instanceof ApiError && (e.status === 410 || e.status === 409 || e.status === 404)) {
          setRefused(
            e.status === 410
              ? `Retrieval refused: the petition is ${String(e.body.state ?? e.code).toLowerCase()}. Nothing was sent; the petition key in this browser was deleted.`
              : "Retrieval refused: the petition has not reached quorum.",
          );
        } else throw e;
      } finally {
        if (live()) setN((x) => x + 1);
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
      {fetchError && (
        <LoadProblem what={p ? "the latest petition status" : "this petition"} error={fetchError} onRetry={() => setN((x) => x + 1)} stale={!!p} />
      )}
      {!p && !missing && !fetchError && <Loading what="the petition" />}
      {missing && (
        <>
          <p role="status" className="bg-missing">This petition is not available to {name(me)}. Nothing is released through this link.</p>
          <Relay mode="idle" threshold={props.items[0]?.threshold ?? 2} approvals={0} names={[]} pulse={NONE} windowLeft={null} />
        </>
      )}
      {p && (
        <article className={`bg-card s-${p.state.toLowerCase()}${opened ? " is-open" : ""}`} aria-label={`Petition for ${p.item_name}`}>
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

          <RelayPanel p={p} mode={mode} nowMs={nowMs} personas={personas} />

          <div className="bg-instruments">
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
              <dd className="small tnum">{p.expires_at.slice(0, 10)} · {remaining(p.expires_at, nowIso)}</dd>
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
          </div>

          <div className="bg-work">
          {/* The decrypted value comes first in the work area, so the value and Hide are on screen
              without scrolling at 1280x720 and up. The action strip follows it. */}
          {releasedHere && (
            <ReleasedView
              released={props.released!}
              closedAs={terminal ? STATE[p.state].label : null}
              item={item}
              canRotate={p.rotation_owed}
              onHide={props.onHide}
              onRotated={() => run(() => props.onRotated(props.released!.itemId))}
            />
          )}
          <div className="bg-actionstrip" aria-label="Your action">
            {/* Who asked and when the link ends, next to the action, so neither needs a scroll on a 1280-wide screen. */}
            {(p.state === "Open" || p.state === "Approved" || p.state === "Released") && (
              <p className="bg-actionctx small" data-testid="action-context">
                <span>
                  Requester <strong>{name(p.requester_id)}</strong>
                </span>
                <span>
                  Link ends <strong className="tnum">{hms(p.expires_at)} UTC</strong> <span className="tnum">({remaining(p.expires_at, nowIso)})</span>
                </span>
              </p>
            )}
            {/* Rotation is metadata only: it stays available after Hide or a reload, without the credential or a new retrieval. */}
            {mine && p.state === "Released" && p.rotation_owed && item?.rotation_state === "rotation_required" && !releasedHere && (
              <div className="bg-rotate">
                <p className="small">
                  <strong>Rotation required.</strong> Rotate it where it was issued, then record that here. This does not retrieve it again.
                </p>
                <button disabled={busy} onClick={() => run(() => props.onRotated(p.item_id))}>
                  I rotated it in the issuing system
                </button>
              </div>
            )}
            {eligible && p.state === "Open" && !approvedByMe && (
              <>
                <button
                  className="primary"
                  disabled={busy}
                  aria-describedby={`keyline-${p.petition_id}`}
                  onClick={() => run(async () => { await approvePetition(api, ks, me, pid, live); if (!live()) return; props.onChanged(); setN((x) => x + 1); })}
                >
                  Approve: encrypt my share
                </button>
                <span className="bg-keyline small" id={`keyline-${p.petition_id}`}>
                  to {name(p.requester_id)}'s petition key <code className="tnum">{short(p.fingerprint).split(" ").slice(0, 4).join(" ")}</code>
                </span>
              </>
            )}
            {eligible && approvedByMe && p.state === "Open" && <p className="small">You approved. Another approval from you does not count.</p>}
            {/* Decision D2: any eligible approver, or the item admin, may deny while the petition is Open or Approved. */}
            {(eligible || isAdmin) && (p.state === "Open" || p.state === "Approved") && (
              <DenyControl
                label={eligible ? "Deny" : "Deny as item admin"}
                busy={busy}
                onDeny={() => run(async () => { if (!live()) return; await denyPetition(api, pid); if (!live()) return; props.onChanged(); setN((x) => x + 1); })}
              />
            )}
            {mine && haveKey && (fromLink || p.state === "Approved" || p.state === "Released") && (
              <button className="primary" disabled={busy} onClick={doRetrieve}>
                Retrieve and decrypt in this browser
              </button>
            )}
            {mine && p.state === "Open" && <p className="small">Waiting for approvals. Nothing is released before quorum.</p>}
            {mine && !haveKey && !refused && p.state === "Released" && wasOpenedHere && (
              <p className="small">Opened in this browser; the petition key was deleted after decryption.</p>
            )}
            {mine && !haveKey && !refused && (p.state === "Approved" || (p.state === "Released" && !wasOpenedHere)) && (
              <p className="small bg-missing-key" role="note">
                This browser does not hold this petition's key, so it cannot decrypt here. The key stays in the browser that opened the
                petition: retrieve it there before the window ends. If that browser no longer has it, open a new petition.
              </p>
            )}
            {mine && !haveKey && !refused && p.state !== "Released" && p.state !== "Open" && p.state !== "Approved" && (
              <p className="small">This browser does not hold this petition's key (it was used or removed).</p>
            )}
            {!mine && !eligible && !isAdmin && <p className="small muted">No action for your role on this petition.</p>}
            {!mine && eligible && p.state !== "Open" && p.state !== "Approved" && <p className="small muted">Approvals are closed for this petition.</p>}
            {!mine && eligible && p.state === "Approved" && <p className="small muted">Quorum reached; approvals are closed for this petition.</p>}
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
          </div>
        </article>
      )}
    </section>
  );
}

function ItemsPanel(props: { items: BgItem[]; isAdmin: boolean; personas: Persona[]; onChanged: () => void }) {
  const { items, isAdmin, onChanged } = props;
  // The draft belongs to one item: choosing another item, cancelling or a
  // persona switch (this panel remounts) discards it, so a value typed for
  // item A can never be shown for, or sealed into, item B.
  const [draft, setDraft] = useState<{ itemId: string; text: string } | null>(null);
  const { busy, error, run } = useAction();
  const names = useMemo(() => new Map(props.personas.map((p) => [p.id, p.name])), [props.personas]);
  const draftItem = draft ? items.find((i) => i.item_id === draft.itemId) : undefined;
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
            {isAdmin && i.rotation_state === "rotation_required" && (
              <span>
                <button disabled={busy} onClick={() => run(async () => { await confirmRotation(api, i.item_id); onChanged(); })}>
                  Record rotation
                </button>
              </span>
            )}
            {isAdmin && (
              <span>
                <button aria-pressed={draft?.itemId === i.item_id} onClick={() => setDraft(draft?.itemId === i.item_id ? draft : { itemId: i.item_id, text: "" })}>
                  Reseal
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {isAdmin && draft && draftItem && (
        <div className="bg-reseal" key={draft.itemId}>
          <h3>Reseal {draftItem.name} with a new value</h3>
          <p className="small muted">
            The browser generates a fresh key and a fresh 2-of-4 share set. Open petitions for the old version are invalidated. Old shares and keys
            cannot open the new version.
          </p>
          <div className="field">
            <label htmlFor="new-secret">New credential for {draftItem.name} (fictional)</label>
            <textarea
              id="new-secret"
              autoComplete="off"
              spellCheck={false}
              value={draft.text}
              onChange={(e) => setDraft({ itemId: draft.itemId, text: e.target.value })}
            />
          </div>
          <div className="row">
            <button
              className="primary"
              disabled={busy || !draft.text}
              onClick={() => {
                const { itemId, text } = draft; // sealed exactly as shown: this item, this text
                run(async () => {
                  await sealItem(api, itemId, text, APPROVERS, 2);
                  setDraft((d) => (d && d.itemId === itemId ? null : d));
                  onChanged();
                });
              }}
            >
              Seal new version
            </button>
            <button onClick={() => setDraft(null)}>Cancel</button>
          </div>
        </div>
      )}
      <ErrorLine error={error} />
    </section>
  );
}

/**
 * Deny is terminal, so it asks once, in the page: the first press opens a
 * small confirmation with Cancel focused; Escape or Cancel closes it.
 */
function DenyControl({ label, busy, onDeny }: { label: string; busy: boolean; onDeny: () => void }) {
  const [asking, setAsking] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (asking) cancel.current?.focus();
  }, [asking]);
  const close = () => {
    setAsking(false);
    window.requestAnimationFrame(() => opener.current?.focus());
  };
  if (!asking) {
    return (
      <button ref={opener} className="danger" disabled={busy} aria-haspopup="true" onClick={() => setAsking(true)}>
        {label}
      </button>
    );
  }
  return (
    <div
      className="bg-confirm"
      role="group"
      aria-label="Confirm deny"
      onKeyDown={(e) => {
        if (e.key === "Escape") close();
      }}
    >
      <span className="small">Deny closes this petition for good. A new release needs a new petition.</span>
      <button ref={cancel} disabled={busy} onClick={close}>
        Cancel
      </button>
      <button
        className="danger"
        disabled={busy}
        onClick={() => {
          setAsking(false);
          onDeny();
        }}
      >
        Deny petition
      </button>
    </div>
  );
}

function ReleasedView(props: {
  released: Released;
  /** Set when the service has since closed the petition: the label of that terminal state. */
  closedAs: string | null;
  item: BgItem | undefined;
  /** The service says this petition's release opened the current rotation obligation. */
  canRotate: boolean;
  onHide: () => void;
  onRotated: () => void;
}) {
  const { released, item, closedAs, canRotate } = props;
  const [copied, setCopied] = useState(false);
  return (
    <div className={`bg-released${closedAs ? " closed" : ""}`} aria-labelledby="rel-h" data-testid="released-view">
      {/* Value and Hide first and compact: both stay on screen at 1280x720 without scrolling. */}
      <div className="bg-released-head">
        <h3 id="rel-h">
          Decrypted and verified in this browser<span className="visually-hidden">: {item?.name ?? released.itemId}</span>
        </h3>
        <div className="bg-released-actions">
          <button
            onClick={async () => {
              await navigator.clipboard.writeText(released.secret);
              setCopied(true);
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
          <button onClick={props.onHide}>Hide</button>
        </div>
      </div>
      <div className="secret">{released.secret}</div>
      {closedAs && (
        <p className="bg-closed-note small" role="status">
          Retrieved earlier, while the petition was active. The service now reports it {closedAs.toLowerCase()} and will not serve it again.
          This copy stays on this page until you hide it.
        </p>
      )}
      <p className="small">
        Rebuilt from the approvers' shares; every share envelope and the item header checked out here. Only this item's key was rebuilt.
        Hiding it clears it from this page.
      </p>
      <p className="notice">{released.notice}</p>
      {canRotate && item?.rotation_state === "rotation_required" && (
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
