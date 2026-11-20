// Last Light: a family archive handed over when the owner stops checking in
// and enough trustees act together.

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import QRCode from "qrcode";
import { Api } from "@coven/ui-kit/api.ts";
import { IndexedDbKeyStore } from "@coven/ui-kit/keystore.ts";
import {
  addItem,
  beginRecovery,
  bundle,
  checkIn,
  completeRecovery,
  demoProgress,
  listVaults,
  myCard,
  OWNER,
  reconcileRecovery,
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
  utcDate,
} from "@coven/ui-kit/components.tsx";
import type { Persona } from "@coven/ui-kit/common.ts";
import { prefersReducedMotion, useFlash, useNewlyAdded } from "@coven/ui-kit/motion.ts";
import { RecoveryIncompleteError, type OpenedRecovery } from "@coven/core-ts/release";
import type { Receipt, RecordEntry } from "@coven/core-ts/records";
import { VaultCore } from "./Scene.tsx";

const api = new Api({ app: "last-light" });
const ks = new IndexedDbKeyStore("coven-last-light");

type State = VaultStatus["state"];
type Recovery = NonNullable<VaultStatus["recovery"]>;

const STATE_LINE: Record<State, string> = {
  Lit: "The owner checked in on time. The vault stays sealed.",
  Flicker: "A check-in was missed, and the owner has been reminded.",
  Vigil: "The vigil is running. A check-in now still cancels the handover.",
  Handover: "Handover has started. The vigil ended and the trustees were told. A check-in still cancels it until release.",
  Released:
    "Released. The service sent the encrypted package to the recovering trustee. Only that trustee's browser can rebuild and check the vault key.",
};

/** Readout text while no recovery is open. */
const SEALED_BODY: Record<State, string> = {
  Lit: "The vault stays encrypted. A recovery can start only after a missed check-in and the vigil.",
  Flicker: "A check-in was missed. A recovery cannot start before the vigil ends.",
  Vigil: "The vigil is running. A check-in still cancels the handover.",
  Handover: "Handover started. A trustee can open a recovery.",
  Released: "The package was sent to the recovering trustee.",
};

const STAGES: State[] = ["Lit", "Flicker", "Vigil", "Handover", "Released"];

/** What setupDemo configures before a vault exists: 3 of 5, check-ins every 30 days, a 14-day vigil. */
const DEMO_THRESHOLD = 3;
const STEP_HINT: Record<State, string> = {
  Lit: "every 30 days",
  Flicker: "missed check-in",
  Vigil: "14-day wait",
  Handover: "trustees told",
  Released: "after quorum",
};

const EVENT: Record<string, string> = {
  "vault.created": "The vault was created",
  "item.sealed": "A letter was sealed",
  "card.issued": "A trustee opened their share card",
  checkin: "The owner checked in",
  "lantern.flicker": "A check-in was missed",
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
  const { personas, me, switchTo, epoch, pending, runSignedInFlow, sessionError, retrySession } = usePersonas(api, "last-light", OWNER);
  const [vaults, setVaults] = useState<VaultStatus[] | null>(null); // null until a load succeeds
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  // Full-width area under the scene where verified letters are laid out. The
  // recovery panel still owns them, so they unmount with it on any persona switch.
  const [readingSlot, setReadingSlot] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!me || pending) return; // never load role-scoped data while the session is changing
    let stale = false;
    const e = currentEpoch();
    const live = () => !stale && isCurrentEpoch(e);
    // If the service never answers, say so with a retry instead of waiting silently.
    const slow = window.setTimeout(() => {
      if (live()) setLoadError("the service has not answered for 12 seconds");
    }, 12_000);
    listVaults(api)
      .then(
        (vs) => {
          if (!live()) return;
          setVaults(vs);
          setLoadError(null);
        },
        // A failed load is never shown as "no vault yet": it stays visible with a retry.
        (err) => { if (live()) setLoadError(errorText(err)); },
      )
      .finally(() => window.clearTimeout(slow));
    return () => {
      stale = true;
      window.clearTimeout(slow);
    };
  }, [me, epoch, pending, tick]);

  const v = vaults?.[0];
  const progress = demoProgress(v);
  const ready = !!v && progress.ready;
  const latest = useLatestRecord(api, ready && v ? `ll:${v.vault_id}` : null, `${tick}-${me}-${v?.receipt.length}`);

  // Before a vault exists, the stage previews the demo trustees by name.
  const keeperIds = personas.filter((p) => p.id !== OWNER).map((p) => p.id);
  const room = ready && v ? v.state.toLowerCase() : "setup";

  return (
    <div className={`ll-app room-${room}`}>
      <a className="skip" href="#main">Skip to content</a>
      <header className="ll-top">
        <div className="ll-brand">
          <CovenMark />
          <span className="ll-wordmark">Last Light</span>
          <span className="ll-tagline">A family archive, opened together when it is needed.</span>
        </div>
        {/* While any sign-in is in flight, everything role-scoped is inert. */}
        <div className="ll-demo" inert={pending}>
          <DemoClock api={api} ks={ks} serverNow={v?.server_now ?? null} steps={[clock.days(7), clock.days(30)]} onChanged={refresh} />
        </div>
        <RoleSwitch personas={personas} me={me} onPersona={switchTo} pending={pending} />
      </header>

      <main id="main" className="ll-main" inert={pending} aria-busy={pending}>
        {sessionError && <LoadProblem what="your demo session" error={sessionError} onRetry={retrySession} />}
        {!me && !sessionError && <Loading what="the demo session" />}
        {me && loadError && <LoadProblem what={vaults ? "the latest vault status" : "the vault"} error={loadError} onRetry={refresh} stale={!!vaults} />}
        {me && !vaults && !loadError && <Loading what="the vault" />}
        {/* Each scene draws the intro, the key reconstruction stage and the role console under it. */}
        <div className="ll-scene">
          {/* One setup view for both an empty service and a partial demo vault, so an error stays on screen as it turns into "finish". */}
          {vaults && (!v || !ready) && me === OWNER && (
            <SetupScene keeperIds={keeperIds} personas={personas} runSignedInFlow={runSignedInFlow} progress={v ? progress : undefined} />
          )}
          {vaults && (!v || !ready) && me && me !== OWNER && <EmptyScene keeperIds={keeperIds} personas={personas} progress={v ? progress : undefined} />}
          {ready && v && me && (
            <VaultScene
              key={`${me}:${epoch}:${v.vault_id}`}
              v={v}
              me={me}
              epoch={epoch}
              personas={personas}
              latest={latest}
              readingSlot={readingSlot}
              onChanged={refresh}
            />
          )}
        </div>

        {ready && v && me && <div className="ll-reading-slot" ref={setReadingSlot} />}
        {ready && v && me && <VaultLower v={v} me={me} epoch={epoch} personas={personas} onChanged={refresh} />}
      </main>

      {ready && v && me && (
        <aside className="ll-proof" aria-labelledby="proof-h" inert={pending}>
          <h2 id="proof-h" className="ll-section-title">Proof, mail and offline copy</h2>
          <div className="ll-proof-grid">
            <details className="evidence" data-next="bundle">
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

/* ---------- the key reconstruction stage ---------- */

type Phase = "setup" | "sealed" | "waiting" | "quorum" | "sent" | "fetching" | "verified" | "failed" | "error";
type NodeState = "preview" | "held" | "awaiting" | "accepted" | "used" | "unusable";
type NodeView = { id: string; name: string; state: NodeState; note: string; you: boolean; recoverer: boolean };

/** What this browser's recovery panel tells the scene. Metadata only: no shares, keys or letters. */
type LocalTrace = {
  recoveryId: string;
  phase: "fetching" | "verified" | "failed" | "error";
  /** The encrypted package arrived in this browser (completeRecovery's onPackage fired). */
  received: boolean;
  /** Trustees whose shares rebuilt the verified key. */
  used: string[];
  /** Trustees whose contribution could not be used here. */
  failed: string[];
  usable: number | null;
  needed: number | null;
};

type TraceState = "verified" | "local" | "service" | "active" | "failed" | "pending" | "remote";
type TraceRow = { label: string; state: TraceState; detail: string };

const TRACE_SR: Record<TraceState, string> = {
  verified: "Done",
  local: "Done",
  service: "Not in this browser yet",
  active: "In progress",
  failed: "Failed",
  pending: "Not yet",
  remote: "Not visible here",
};

const NODE_H = 46;
const NODE_GAP = 7;

function firstName(personas: Persona[], id: string) {
  return personaName(personas, id).split(" ")[0];
}

/** The five lifecycle stages with the service's dates. */
function Steps({ v }: { v: VaultStatus | null }) {
  const when: Record<State, string> = v
    ? {
        Lit: `until ${utcDate(v.next_due_at)}`,
        Flicker: `from ${utcDate(v.next_due_at)}`,
        Vigil: `from ${utcDate(v.vigil_starts_at)}`,
        Handover: `from ${utcDate(v.handover_at)}`,
        Released: "after quorum",
      }
    : STEP_HINT;
  const at = v ? STAGES.indexOf(v.state) : -1;
  return (
    <ol className="ll-steps" aria-label="Lifecycle">
      {STAGES.map((s, i) => (
        <li key={s} className={`ll-step ${i < at ? "past" : i === at ? "current" : "ahead"}`} aria-current={i === at ? "step" : undefined}>
          <span className="ll-step-name">{s}</span>
          <span className="ll-step-when tnum">{when[s]}</span>
        </li>
      ))}
    </ol>
  );
}

/** Where a next-step jump lands: an existing control below the stage. The jump never acts by itself. */
type NextTarget = "card" | "open" | "share" | "fetch" | "bundle";
type Next = { text: string; target?: NextTarget };
const JUMP: Record<NextTarget, string> = {
  card: "Jump to my share card",
  open: "Jump to the recovery controls",
  share: "Jump to the recovery controls",
  fetch: "Jump to the recovery controls",
  bundle: "Jump to the offline bundle",
};

/** The one next step for this role and state, from the vault status and this browser's own evidence. */
function nextStep(o: {
  v: VaultStatus;
  me: string;
  rec: Recovery | null;
  isOwner: boolean;
  isTrustee: boolean;
  recoveryLive: boolean;
  quorum: boolean;
  localKey: boolean | null;
  lt: LocalTrace | null;
}): Next | null {
  const { v, me, rec, isOwner, isTrustee, recoveryLive, quorum, localKey, lt } = o;
  if (isOwner) return v.state === "Released" ? null : { text: "Check in before the due date, above. A check-in cancels any pending handover." };
  if (!isTrustee || lt?.phase === "verified" || lt?.phase === "fetching") return null;
  if (!recoveryLive) return { text: "Print your share card and keep it like a key.", target: "card" };
  if (!rec) return v.state === "Handover" ? { text: "Open a recovery to collect the shares in this browser.", target: "open" } : null;
  const mine = rec.recoverer_id === me;
  if (!rec.submitted_by.includes(me)) return { text: "Add your share to this recovery.", target: "share" };
  if (!mine) return { text: "Your share is in. The recovering trustee rebuilds the key in their browser." };
  if (localKey === null) return { text: "Checking whether this browser holds the recovery's one-time key." };
  if (localKey === false)
    return { text: `Fetch in the browser that opened this recovery, or use ${v.threshold} printed cards and the bundle offline.`, target: "bundle" };
  if (!quorum) return { text: "Wait for more shares. Refresh status to see new ones." };
  return { text: rec.state === "Complete" ? "Fetch the package again to rebuild the key here." : "Fetch the package to rebuild the key here.", target: "fetch" };
}

/** Bring an existing control into view and focus it. */
function jumpTo(target: NextTarget) {
  const el = document.querySelector<HTMLElement>(`[data-next="${target}"]`);
  if (!el) return;
  const behavior: ScrollBehavior = prefersReducedMotion() ? "auto" : "smooth";
  if (el instanceof HTMLDetailsElement) {
    el.open = true;
    const summary = el.querySelector<HTMLElement>("summary");
    summary?.scrollIntoView({ block: "center", behavior });
    summary?.focus({ preventScroll: true });
    return;
  }
  el.scrollIntoView({ block: "center", behavior });
  el.focus({ preventScroll: true });
}

/**
 * Trustee nodes on their tracks into the vault block, and the threshold
 * readout. Every graphical state comes from the props: the service's accepted
 * shares and threshold, or what this browser verified.
 */
function Stage(props: {
  sub: string;
  steps: ReactNode;
  nodes: NodeView[];
  threshold: number;
  accepted: number;
  phase: Phase;
  core: { title: string; caption: string };
  countLine: string;
  status: string;
  statusBody: string;
  next?: Next | null;
  refresh?: { at: string; onRefresh: () => void };
  trace?: ReactNode;
  extra?: ReactNode;
  signals?: ReadonlySet<string>;
  converging?: boolean;
  opening?: boolean;
  pulse?: boolean;
  selected?: string | null;
  onSelect?: (id: string | null) => void;
  inspector?: ReactNode;
}) {
  const { nodes, threshold, accepted, phase, signals, selected = null, onSelect } = props;
  const total = nodes.length * NODE_H + Math.max(0, nodes.length - 1) * NODE_GAP;
  const ys = nodes.map((_, i) => ((i * (NODE_H + NODE_GAP) + NODE_H / 2) / Math.max(1, total)) * 100);
  const lit = (n: NodeView) => n.state === "accepted" || n.state === "used";
  const shown = Math.min(accepted, threshold);
  return (
    <section
      className={`ll-stage ph-${phase}${props.converging ? " converging" : ""}${props.opening ? " opening" : ""}${props.pulse ? " pulse" : ""}`}
      aria-labelledby="stage-h"
      onKeyDown={(e) => {
        if (e.key === "Escape" && selected && onSelect) onSelect(null);
      }}
    >
      <div className="ll-visual">
        <header className="ll-visual-head">
          <div className="ll-visual-title">
            <h2 id="stage-h">Key reconstruction</h2>
            <span>{props.sub}</span>
          </div>
          {props.steps}
        </header>
        <div className="ll-mapping">
          <ol className="ll-nodes" aria-label="Trustee shares">
            {nodes.map((n) => {
              const inner = (
                <>
                  <span className="ll-node-initial" aria-hidden="true">
                    {n.name.charAt(0).toUpperCase()}
                  </span>
                  <span className="ll-node-text">
                    <span className="ll-node-name">
                      {n.name}
                      {n.you && <span className="ll-node-tag">you</span>}
                      {n.recoverer && <span className="ll-node-tag rec">recovering</span>}
                    </span>
                    <span className="ll-node-note">{n.note}</span>
                  </span>
                  <i className="ll-node-dot" aria-hidden="true" />
                </>
              );
              return (
                <li key={n.id} className={`ll-node st-${n.state}${selected === n.id ? " selected" : ""}${signals?.has(n.id) ? " fresh" : ""}`}>
                  {onSelect ? (
                    <button
                      type="button"
                      className="ll-node-box"
                      data-node={n.id}
                      aria-pressed={selected === n.id}
                      aria-controls="ll-inspector"
                      onClick={() => onSelect(selected === n.id ? null : n.id)}
                    >
                      {inner}
                    </button>
                  ) : (
                    <div className="ll-node-box">{inner}</div>
                  )}
                </li>
              );
            })}
          </ol>
          <div className="ll-routes" aria-hidden="true" style={{ height: `${total}px` }}>
            <svg className="ll-tracks" viewBox="0 0 100 100" preserveAspectRatio="none" focusable="false">
              {nodes.map((n, i) => (
                <g key={n.id} className={`ll-track${lit(n) ? " lit" : ""}`}>
                  <path className="glow" d={`M0 ${ys[i]} H38 L78 50 H100`} />
                  <path className="line" d={`M0 ${ys[i]} H38 L78 50 H100`} />
                </g>
              ))}
            </svg>
            {nodes.map((n, i) =>
              signals?.has(n.id) ? (
                <span key={n.id} className="ll-signal" style={{ "--y": `${ys[i]}%` } as CSSProperties} />
              ) : null,
            )}
            {/* The quorum beat has its own packets, so a still-running share signal cannot absorb it. */}
            {props.converging &&
              nodes.map((n, i) =>
                lit(n) ? <span key={`beat:${n.id}`} className="ll-packet" style={{ "--y": `${ys[i]}%` } as CSSProperties} /> : null,
              )}
          </div>
          <div className="ll-core-region" aria-hidden="true">
            <VaultCore title={props.core.title} caption={props.core.caption} />
          </div>
        </div>
        {props.inspector}
      </div>
      <aside className="ll-readout">
        <div className="ll-readout-head">
          <h2 className="ll-readout-k">Recovery threshold</h2>
          {props.refresh && (
            <div className="ll-refresh">
              {/* Re-reads the vault status under the current role only (the load is epoch-guarded). */}
              <button type="button" className="ll-refresh-btn" onClick={props.refresh.onRefresh}>
                Refresh status
              </button>
              <span className="ll-refresh-at">
                as of <time className="tnum">{utc(props.refresh.at).slice(11)}</time>
              </span>
            </div>
          )}
        </div>
        <p className="ll-fraction tnum">
          <span className="ll-fraction-n">{shown}</span>
          <span className="ll-fraction-of"> / {threshold}</span>
        </p>
        <p className="ll-countline">{props.countLine}</p>
        <div className="ll-gauge" aria-hidden="true">
          {Array.from({ length: threshold }, (_, i) => (
            <i key={i} className={i < shown ? "on" : ""} />
          ))}
        </div>
        <div className="ll-readout-status" aria-live="polite">
          <p className="ll-status">{props.status}</p>
          <p className="ll-status-body">{props.statusBody}</p>
        </div>
        {props.next && (
          <div className="ll-nextstep">
            <p className="ll-nextstep-text">
              <span className="ll-nextstep-k">Next</span> {props.next.text}
            </p>
            {props.next.target && (
              <button type="button" className="ll-nextstep-jump" onClick={() => jumpTo(props.next!.target!)}>
                {JUMP[props.next.target]}
              </button>
            )}
          </div>
        )}
        {props.trace}
        {props.extra}
      </aside>
    </section>
  );
}

/** The real reconstruction stages. Only this browser's own result marks a stage done. */
function Trace({ rows }: { rows: TraceRow[] }) {
  return (
    <ol className="ll-trace" aria-label="Reconstruction trace">
      {rows.map((r) => (
        <li key={r.label} className={`ll-trace-row t-${r.state}`}>
          <span className="ll-trace-mark" aria-hidden="true" />
          <span className="ll-trace-label">
            <span className="visually-hidden">{TRACE_SR[r.state]}: </span>
            {r.label}
          </span>
          <span className="ll-trace-detail">{r.detail}</span>
        </li>
      ))}
    </ol>
  );
}

function traceRows(rec: Recovery, threshold: number, lt: LocalTrace | null, isRecoverer: boolean, recoverer: string): TraceRow[] {
  const accepted = rec.submitted_by.length;
  const quorum = accepted >= threshold;
  // Complete means the service sent the package. It says nothing about any browser rebuilding the key.
  const sent = rec.state === "Complete";
  const need = Math.max(0, threshold - accepted);
  const waiting = `needs ${need} more ${need === 1 ? "share" : "shares"}`;
  const P = "Encrypted package received";
  const K = "Key reconstructed";
  const V = "Vault verified";
  if (!isRecoverer) {
    const remote = `only in ${recoverer}'s browser`;
    return [
      { label: P, state: sent ? "service" : "pending", detail: sent ? `delivered to ${recoverer}` : quorum ? `ready for ${recoverer}` : waiting },
      { label: K, state: "remote", detail: remote },
      { label: V, state: "remote", detail: remote },
    ];
  }
  const fetching = lt?.phase === "fetching";
  const received = !!lt?.received;
  const row1: TraceRow = received
    ? { label: P, state: "local", detail: "in this browser" }
    : fetching
      ? { label: P, state: "active", detail: "requesting the package" }
      : lt?.phase === "error"
        ? { label: P, state: "failed", detail: "request failed · see the error below" }
        : sent
          ? { label: P, state: "service", detail: "sent earlier · fetch again to rebuild here" }
          : { label: P, state: "pending", detail: quorum ? "ready to fetch" : waiting };
  const row2: TraceRow =
    lt?.phase === "verified"
      ? { label: K, state: "verified", detail: `from ${lt.used.length} shares` }
      : lt?.phase === "failed"
        ? { label: K, state: "failed", detail: `${lt.usable ?? 0} usable of ${lt.needed ?? threshold} needed` }
        : fetching && received
          ? { label: K, state: "active", detail: "rebuilding in this browser" }
          : lt?.phase === "error" && received
            ? { label: K, state: "failed", detail: "stopped · see the error below" }
            : { label: K, state: "pending", detail: "not started" };
  const row3: TraceRow =
    lt?.phase === "verified"
      ? { label: V, state: "verified", detail: "header check passed" }
      : { label: V, state: "pending", detail: lt?.phase === "failed" || lt?.phase === "error" ? "not reached" : "not started" };
  return [row1, row2, row3];
}

/** Details for one trustee, from data this viewer already has: the vault status and this browser's own result. */
function Inspector(props: {
  id: string | null;
  v: VaultStatus;
  me: string;
  personas: Persona[];
  rec: Recovery | null;
  lt: LocalTrace | null;
  onClose: () => void;
}) {
  const { id, v, me, personas, rec, lt, onClose } = props;
  if (!id) {
    return (
      <div className="ll-inspector" id="ll-inspector" role="region" aria-label="Trustee details" aria-live="polite">
        <p className="ll-inspector-hint">Select a trustee to see their share status and role.</p>
      </div>
    );
  }
  const name = personaName(personas, id);
  const first = name.split(" ")[0];
  const order = rec ? rec.submitted_by.indexOf(id) : -1;
  const recovery = !rec ? "No recovery open" : order >= 0 ? "Share accepted" : "Awaiting share";
  const here = lt
    ? lt.used.includes(id)
      ? "Used to rebuild the key"
      : lt.failed.includes(id)
        ? "Could not be used here"
        : lt.phase === "verified"
          ? "Not needed for the rebuild"
          : null
    : null;
  const letters = v.items.filter((i) => i.deliver_to.some((d) => d.trim().toLowerCase() === first.toLowerCase())).map((i) => i.label);
  return (
    <div className="ll-inspector open" id="ll-inspector" role="region" aria-label="Trustee details" aria-live="polite">
      <span className="ll-insp-initial" aria-hidden="true">
        {first.charAt(0).toUpperCase()}
      </span>
      <p className="ll-insp-id">
        <b>{name}</b>
        {id === me && <span className="ll-node-tag">you</span>}
        <span className="ll-insp-role">{personaRole(personas, id) || "Trustee"}</span>
      </p>
      <dl className="ll-insp-facts">
        <div>
          <dt>Share</dt>
          <dd>
            1 of {v.trustee_ids.length} · any {v.threshold} recover
          </dd>
        </div>
        <div>
          <dt>Recovery</dt>
          <dd>
            {recovery}
            {rec?.recoverer_id === id ? " · opened it" : ""}
          </dd>
        </div>
        {here && (
          <div>
            <dt>This browser</dt>
            <dd>{here}</dd>
          </div>
        )}
        <div>
          <dt>Named on</dt>
          <dd>{letters.length > 0 ? letters.join(", ") : "No letters"}</dd>
        </div>
      </dl>
      <button type="button" className="ll-insp-close" onClick={onClose} aria-label="Close trustee details">
        ×
      </button>
    </div>
  );
}

/** The owner's check-in, with the next date the service set. */
function CheckInPanel({ v, pulse, onChanged }: { v: VaultStatus; pulse: boolean; onChanged: () => void }) {
  const { busy, error, run } = useAction();
  const overdue = v.state === "Flicker" || v.state === "Vigil" || v.state === "Handover";
  if (v.state === "Released") {
    return (
      <div className="ll-card ll-checkin done">
        <p className="ll-card-k">Owner check-in</p>
        <p className="ll-card-note">The package was sent, so a check-in can no longer undo the handover.</p>
      </div>
    );
  }
  return (
    <div className={`ll-card ll-checkin${overdue ? " overdue" : ""}${pulse ? " pulse" : ""}`}>
      <p className="ll-card-k">{overdue ? "Check-in was due" : "Next check-in due"}</p>
      <div className="ll-checkin-row">
        <time className="ll-checkin-date tnum">{utcDate(v.next_due_at)}</time>
        <button className="primary ll-checkin-btn" disabled={busy} onClick={() => run(async () => { await checkIn(api, v.vault_id); onChanged(); })}>
          Check in: I'm here
        </button>
      </div>
      <p className="ll-card-note">
        Last check-in <time className="tnum">{utcDate(v.last_checkin_at)}</time> · due every {v.cadence_days} days. A check-in before release
        cancels any pending handover.
      </p>
      <ErrorLine error={error} />
    </div>
  );
}

function RoleCard(props: { v: VaultStatus; me: string; personas: Persona[]; rec: Recovery | null; keyHere: boolean | null }) {
  const { v, me, personas, rec, keyHere } = props;
  const line = !rec
    ? `Any ${v.threshold} trustees can recover the vault together.`
    : rec.recoverer_id === me
      ? keyHere === false
        ? "You opened this recovery. Its one-time key is not in this browser."
        : keyHere
          ? "You opened this recovery. The package comes to this browser."
          : "You opened this recovery."
      : rec.submitted_by.includes(me)
        ? "Your share is in this recovery."
        : "Your share is not in this recovery yet.";
  return (
    <div className="ll-card ll-rolecard">
      <p className="ll-card-k">Trustee · {personaName(personas, me)}</p>
      <p className="ll-rolecard-main">You hold 1 of {v.trustee_ids.length} shares</p>
      <p className="ll-card-note">{line}</p>
    </div>
  );
}

function previewNodes(ids: string[], personas: Persona[]): NodeView[] {
  return ids.map((id) => ({ id, name: firstName(personas, id), state: "preview", note: "Will hold a share", you: false, recoverer: false }));
}

type Progress = { sealed: number; total: number };

function SetupScene(props: {
  keeperIds: string[];
  personas: Persona[];
  runSignedInFlow: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
  /** Set when an earlier setup stopped part way: the vault exists without every letter. */
  progress?: Progress;
}) {
  const { keeperIds, personas, runSignedInFlow, progress } = props;
  const [log, setLog] = useState<string[]>([]);
  const { busy, error, run } = useAction();
  return (
    <>
      <section className="ll-intro" aria-labelledby="setup-h">
        <div className="ll-intro-main">
          <p className="ll-kicker">{progress ? `Setup did not finish · ${progress.sealed} of ${progress.total} letters sealed` : "Last Light · fictional demo"}</p>
          <h1 id="setup-h" className="ll-title">{progress ? "Finish the demo setup" : "Set up the fictional family"}</h1>
          <p className="ll-meta">
            <span className="ll-meta-text">
              {progress
                ? "An earlier setup stopped part way. Running it again reuses the demo vault and adds only the missing letters, so nothing is created twice."
                : "Mara Hollow keeps letters for her family. Five trustees each hold one piece of the key; any three can open the vault together."}
            </span>
          </p>
        </div>
        <div className="ll-card ll-setupcard">
          <p className="ll-card-k">Fictional demo</p>
          <button
            className="primary ll-setup-btn"
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
          <p className="ll-card-note">
            This creates key pairs in this browser for Mara and her five trustees. Mara's browser then makes a vault key, splits it 3 of 5 and
            seals three letters. Check-ins are due every 30 days, with a 14-day vigil.
          </p>
          <ErrorLine error={error} />
        </div>
      </section>
      <Stage
        sub={`${keeperIds.length} trustee shares · any ${DEMO_THRESHOLD}`}
        steps={<Steps v={null} />}
        nodes={previewNodes(keeperIds, personas)}
        threshold={DEMO_THRESHOLD}
        accepted={0}
        phase="setup"
        core={{ title: "No vault yet", caption: "Nothing sealed" }}
        countLine="no vault yet"
        status={busy ? "Setting up" : "Ready to set up"}
        statusBody="Setup makes the vault key in this browser and splits it among the trustees."
        extra={
          log.length > 0 && (
            <ol className="ll-log" aria-live="polite">
              {log.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ol>
          )
        }
      />
    </>
  );
}

function EmptyScene({ keeperIds, personas, progress }: { keeperIds: string[]; personas: Persona[]; progress?: Progress }) {
  return (
    <>
      <section className="ll-intro" aria-labelledby="empty-h">
        <div className="ll-intro-main">
          <p className="ll-kicker">{progress ? `Setup did not finish · ${progress.sealed} of ${progress.total} letters sealed` : "Last Light"}</p>
          <h1 id="empty-h" className="ll-title">{progress ? "Demo setup did not finish" : "No vault yet"}</h1>
          <p className="ll-meta">
            <span className="ll-meta-text">
              {progress
                ? "Switch to Mara Hollow (vault owner) to finish the setup."
                : "No vault yet. Switch to Mara Hollow (vault owner) to set up the demo."}
            </span>
          </p>
        </div>
      </section>
      <Stage
        sub={`${keeperIds.length} trustee shares · any ${DEMO_THRESHOLD}`}
        steps={<Steps v={null} />}
        nodes={previewNodes(keeperIds, personas)}
        threshold={DEMO_THRESHOLD}
        accepted={0}
        phase="setup"
        core={{ title: "No vault yet", caption: "Nothing sealed" }}
        countLine="no vault yet"
        status="Waiting for the owner"
        statusBody="Only the vault owner can set up the demo."
      />
    </>
  );
}

/** Mounted per persona, role epoch and vault: no local result, selection or animation carries over a switch. */
function VaultScene(props: {
  v: VaultStatus;
  me: string;
  epoch: number;
  personas: Persona[];
  latest: RecordEntry | null;
  readingSlot: HTMLElement | null;
  onChanged: () => void;
}) {
  const { v, me, epoch, personas, latest, readingSlot, onChanged } = props;
  // Role-scoped panels are remounted (all local state dropped) when the persona,
  // the vault or the recovery changes, and as soon as a persona switch starts.
  const cardKey = `${me}:${epoch}:${v.vault_id}`;
  const recoveryKey = `${cardKey}:${v.recovery?.recovery_id ?? "none"}`;
  const isOwner = me === v.owner_id;
  const isTrustee = v.trustee_ids.includes(me);
  const recoveryLive = v.state === "Handover" || v.state === "Released";
  const rec = v.recovery && v.recovery.state !== "Cancelled" ? v.recovery : null;
  const T = v.threshold;
  const submitted = rec?.submitted_by ?? [];
  const accepted = submitted.length;
  const quorum = !!rec && accepted >= T;
  const isRecoverer = !!rec && rec.recoverer_id === me;
  const recoverer = rec ? firstName(personas, rec.recoverer_id) : "";

  // Metadata reported by this browser's recovery panel. It counts only for the
  // recovery on screen, and only for the trustee who opened it.
  const [local, setLocal] = useState<LocalTrace | null>(null);
  const lt = local && rec && isRecoverer && local.recoveryId === rec.recovery_id ? local : null;
  // Local evidence: does this browser hold the one-time key of the recovery on screen?
  // (Adopts a recovery whose open answer was lost.) null while checking.
  const [localKey, setLocalKey] = useState<boolean | null>(null);
  useEffect(() => {
    let stale = false;
    setLocalKey(null);
    if (rec && isRecoverer) reconcileRecovery(ks, me, v).then((k) => { if (!stale) setLocalKey(k); }, () => { if (!stale) setLocalKey(false); });
    return () => { stale = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec?.recovery_id, isRecoverer, me]);
  const keyElsewhere = isRecoverer && localKey === false && lt === null;
  const keyChecking = isRecoverer && localKey === null && lt === null;
  const [selected, setSelected] = useState<string | null>(null);
  const closeInspector = () => {
    const id = selected;
    setSelected(null);
    if (id) window.requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-node="${CSS.escape(id)}"]`)?.focus());
  };

  // Motion follows confirmed events only: a share the service accepted, the
  // quorum being reached, a recovery this browser verified, a recorded check-in.
  const arrived = useNewlyAdded(rec ? submitted.map((t) => `${rec.recovery_id}|${t}`) : []);
  const signals = new Set([...arrived].map((k) => k.slice(k.indexOf("|") + 1)));
  const converging = useFlash(
    rec ? `${rec.recovery_id}|${quorum ? 1 : 0}` : null,
    (p, n) => p !== null && n !== null && p.split("|")[0] === n.split("|")[0] && p.endsWith("|0") && n.endsWith("|1"),
    2000,
  );
  const opening = useFlash(
    lt ? `${lt.recoveryId}|${lt.phase === "verified" ? 1 : 0}` : null,
    (p, n) => n !== null && n.endsWith("|1") && (p === null || p.endsWith("|0")),
    1800,
  );
  const checkedIn = useFlash(v.last_checkin_at ?? null, (p, n) => p !== null && n !== null, 1600);
  const pulse = checkedIn && v.state === "Lit";

  // Released (Complete) is package delivery only. The vault shows verified only
  // after completeRecovery succeeded in this browser.
  const phase: Phase =
    lt?.phase === "verified"
      ? "verified"
      : lt?.phase === "failed"
        ? "failed"
        : lt?.phase === "error"
          ? "error"
          : lt?.phase === "fetching"
            ? "fetching"
            : !rec
              ? "sealed"
              : rec.state === "Complete"
            ? "sent"
            : quorum
              ? "quorum"
              : "waiting";

  const nodes: NodeView[] = v.trustee_ids.map((t) => {
    const order = submitted.indexOf(t);
    const state: NodeState = lt?.used.includes(t)
      ? "used"
      : lt?.failed.includes(t)
        ? "unusable"
        : !rec
          ? "held"
          : order >= 0
            ? "accepted"
            : "awaiting";
    const note =
      state === "used"
        ? "Used in the rebuild"
        : state === "unusable"
          ? "Not usable here"
          : state === "held"
            ? "Holds a share"
            : state === "accepted"
              ? "Share accepted"
              : "Awaiting share";
    return { id: t, name: firstName(personas, t), state, note, you: t === me, recoverer: rec?.recoverer_id === t };
  });

  const need = Math.max(0, T - accepted);
  const ELSEWHERE = "This browser cannot rebuild the vault key.";
  const CHECKING = "Checking whether this browser holds the recovery's one-time key.";
  const next = nextStep({ v, me, rec, isOwner, isTrustee, recoveryLive, quorum, localKey, lt });
  const text: Record<Phase, [string, string]> = {
    setup: ["", ""],
    sealed: [
      "No recovery open",
      v.state === "Handover" && isTrustee ? "Handover started. Open a recovery below to collect shares in this browser." : SEALED_BODY[v.state],
    ],
    waiting: [
      `${need} ${need === 1 ? "share" : "shares"} to go`,
      isTrustee && !submitted.includes(me) ? "The vault stays encrypted. Submit your share below." : "The vault stays encrypted while trustees submit shares.",
    ],
    quorum: keyElsewhere
      ? ["Quorum reached · key not in this browser", ELSEWHERE]
      : keyChecking
        ? ["Quorum reached", CHECKING]
        : ["Quorum reached", isRecoverer ? "Fetch the package below to rebuild the key in this browser." : `Only ${recoverer}'s browser can rebuild the key.`],
    sent: keyElsewhere
      ? [`Package sent to ${recoverer} · key not in this browser`, ELSEWHERE]
      : keyChecking
        ? [`Package sent to ${recoverer}`, CHECKING]
        : [
            `Package sent to ${recoverer}`,
            isRecoverer
              ? "It was sent earlier. Fetch it again below to rebuild the key here."
              : `Released means delivered. Only ${recoverer}'s browser can rebuild and check the key.`,
          ],
    fetching: lt?.received
      ? ["Rebuilding the key", "The encrypted package arrived. This browser is rebuilding the key and checking the vault."]
      : ["Requesting the package", "This browser asked the service for the encrypted package. The vault stays sealed."],
    verified: ["Verified in this browser", `The key was rebuilt from ${lt?.used.length ?? 0} shares and the header check passed.`],
    failed: [
      "Key not rebuilt",
      `${lt?.usable ?? 0} usable of ${lt?.needed ?? T} needed. The vault stays sealed. Ask another trustee to add a share, then retry with the fetch button below.`,
    ],
    error: ["Fetch did not finish", "The vault stays sealed. The error is shown under the fetch button below."],
  };
  const core: Record<Phase, { title: string; caption: string }> = {
    setup: { title: "No vault yet", caption: "Nothing sealed" },
    sealed: { title: "Vault sealed", caption: "Contents encrypted" },
    waiting: { title: "Vault sealed", caption: `${accepted} of ${T} shares in` },
    quorum: { title: "Vault sealed", caption: "Ready to rebuild" },
    sent: { title: "Vault sealed", caption: "Package delivered" },
    fetching: { title: "Vault sealed", caption: lt?.received ? "Rebuilding key" : "Receiving package" },
    verified: { title: "Vault verified", caption: "Checked in this browser" },
    failed: { title: "Vault sealed", caption: "Key not rebuilt" },
    error: { title: "Vault sealed", caption: "Fetch failed" },
  };
  const countLine = !rec
    ? `none yet · any ${T} of ${v.trustee_ids.length} recover`
    : accepted > T
      ? `${accepted} shares received · ${T} needed`
      : "required shares received";

  return (
    <>
      <section className="ll-intro" aria-labelledby="vault-h">
        <div className="ll-intro-main">
          <p className="ll-kicker">{isOwner ? "Your vault" : `Trustee · ${personaName(personas, me)}`}</p>
          <h1 id="vault-h" className="ll-title">{v.name}</h1>
          <p className="ll-meta">
            <span className={`ll-state s-${v.state.toLowerCase()}`} data-testid="lantern-state">{v.state}</span>
            <span className="ll-meta-text">{STATE_LINE[v.state]}</span>
          </p>
        </div>
        {isOwner && <CheckInPanel v={v} pulse={pulse} onChanged={onChanged} />}
        {!isOwner && isTrustee && <RoleCard v={v} me={me} personas={personas} rec={rec} keyHere={isRecoverer ? localKey : null} />}
      </section>

      <Stage
        sub={`${v.trustee_ids.length} trustee shares · any ${T}`}
        steps={<Steps v={v} />}
        nodes={nodes}
        threshold={T}
        accepted={accepted}
        phase={phase}
        core={core[phase]}
        countLine={countLine}
        status={text[phase][0]}
        statusBody={text[phase][1]}
        next={next}
        refresh={{ at: v.server_now, onRefresh: onChanged }}
        trace={rec && <Trace rows={traceRows(rec, T, lt, isRecoverer, recoverer)} />}
        signals={signals}
        converging={converging}
        opening={opening}
        pulse={pulse}
        selected={selected}
        onSelect={(id) => (id === null ? closeInspector() : setSelected(id))}
        inspector={<Inspector id={selected} v={v} me={me} personas={personas} rec={rec} lt={lt} onClose={closeInspector} />}
      />

      <div className="ll-console">
        {isTrustee && !recoveryLive && <ShareCard key={cardKey} v={v} me={me} epoch={epoch} personas={personas} onChanged={onChanged} lead />}
        {isTrustee && recoveryLive && (
          <RecoveryPanel
            key={recoveryKey}
            v={v}
            me={me}
            epoch={epoch}
            personas={personas}
            readingSlot={readingSlot}
            onLocal={setLocal}
            onChanged={onChanged}
          />
        )}
        <LatestLine entry={latest} />
      </div>
    </>
  );
}

function VaultLower(props: { v: VaultStatus; me: string; epoch: number; personas: Persona[]; onChanged: () => void }) {
  const { v, me, epoch, personas, onChanged } = props;
  const cardKey = `${me}:${epoch}:${v.vault_id}`;
  const isOwner = me === v.owner_id;
  const isTrustee = v.trustee_ids.includes(me);
  const recoveryLive = v.state === "Handover" || v.state === "Released";
  const canAdd = isOwner && v.state !== "Released";
  return (
    <>
      <section className="ll-archive" aria-labelledby="letters-h">
        <div className="ll-archive-head">
          <h2 id="letters-h" className="ll-section-title">Sealed letters</h2>
          <p className="ll-archive-note">
            Names under “for” are routing labels, not separate locks. Earliest release dates are enforced by the online service only.
          </p>
        </div>
        <div className={`ll-shelf${canAdd ? " with-add" : ""}`}>
          <ul className="ll-letter-list">
            {v.items.map((i) => (
              <li key={i.item_id} className={`ll-item${i.earliest_release ? " held" : ""}`}>
                <span className="ll-item-mark" aria-hidden="true" />
                <span className="ll-item-title">{i.label}</span>
                <span className="ll-item-to">for {i.deliver_to.join(", ") || "anyone"}</span>
                <span className="ll-item-when">
                  {i.earliest_release ? <>Held online until <time className="tnum">{i.earliest_release}</time></> : "Opens with the vault"}
                </span>
              </li>
            ))}
          </ul>
          {canAdd && <AddItem vaultId={v.vault_id} onChanged={onChanged} />}
        </div>
      </section>

      {isTrustee && recoveryLive && (
        <section className="ll-cardshelf" aria-label="Share card">
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
          data-next={lead ? "card" : undefined}
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
            <button className="primary" data-next={lead ? "card" : undefined} onClick={() => window.print()}>Print card</button>
            <button onClick={() => setCard(null)}>Hide card</button>
          </div>
        </>
      )}
    </div>
  );
}

function RecoveryPanel(props: {
  v: VaultStatus;
  me: string;
  epoch: number;
  personas: Persona[];
  readingSlot: HTMLElement | null;
  onLocal: (t: LocalTrace | null) => void;
  onChanged: () => void;
}) {
  const { v, me, epoch, personas, readingSlot, onLocal, onChanged } = props;
  const live = useLive(epoch);
  const r = v.recovery;
  const [typed, setTyped] = useState("");
  const [opened, setOpened] = useState<OpenedRecovery | null>(null);
  const [incomplete, setIncomplete] = useState<RecoveryIncompleteError | null>(null);
  const [haveKey, setHaveKey] = useState<boolean | null>(null); // null while this browser is checked
  const [fetchPhase, setFetchPhase] = useState<LocalTrace["phase"] | null>(null);
  const [received, setReceived] = useState(false);
  const { busy, error, run } = useAction();
  const openedRef = useRef<HTMLElement>(null);
  useEffect(() => {
    setOpened(null);
    setIncomplete(null);
    setFetchPhase(null);
    setReceived(false);
    // A recovery whose open answer was lost is adopted here by its one-time key.
    if (r) reconcileRecovery(ks, me, v).then((k) => { if (live()) setHaveKey(k); }, () => { if (live()) setHaveKey(false); });
  }, [r?.recovery_id, me]);
  // Tell the scene what happened in this browser: stage and trustee names
  // only, never shares, keys or letters. Cleared when this panel leaves.
  useEffect(() => {
    onLocal(
      r && fetchPhase
        ? {
            recoveryId: r.recovery_id,
            phase: fetchPhase,
            received,
            used: opened?.used ?? [],
            failed: opened?.failed ?? incomplete?.failed ?? [],
            usable: incomplete?.usable ?? null,
            needed: incomplete?.needed ?? null,
          }
        : null,
    );
  }, [r?.recovery_id, fetchPhase, received, opened, incomplete, onLocal]);
  useEffect(() => () => onLocal(null), [onLocal]);
  // After the header check passed, let the vault open first, then bring the
  // letters into view (again if the refreshed status reflows the page).
  useEffect(() => {
    if (!opened) return;
    const reduce = prefersReducedMotion();
    const t = window.setTimeout(
      () => openedRef.current?.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" }),
      reduce ? 0 : 1700,
    );
    return () => window.clearTimeout(t);
  }, [opened, v.state]);

  const submitted = r?.submitted_by.includes(me);
  const isRecoverer = r?.recoverer_id === me;
  return (
    <div className="ll-action" aria-labelledby="recov-h">
      <h2 id="recov-h" className="ll-subtitle">Recovery</h2>
      {!r && v.state === "Handover" && (
        <>
          <p className="small">Open a recovery to receive the other trustees' shares in this browser. They are encrypted to a one-time key made here.</p>
          <button className="primary" data-next="open" disabled={busy} onClick={() => run(async () => { await beginRecovery(api, ks, me, v.vault_id, live); if (live()) onChanged(); })}>
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
              <button className="primary" data-next="share" disabled={busy} onClick={() => run(async () => { await submitShare(api, ks, me, v, undefined, live); if (live()) onChanged(); })}>
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
                  data-next="fetch"
                  disabled={busy || !haveKey || r.submitted_by.length < v.threshold}
                  onClick={() =>
                    run(async () => {
                      setIncomplete(null);
                      setOpened(null);
                      setReceived(false);
                      setFetchPhase("fetching");
                      try {
                        // onPackage is metadata only: it marks that the encrypted package arrived here.
                        const res = await completeRecovery(api, ks, r.recovery_id, live, () => {
                          if (live()) setReceived(true);
                        });
                        if (live()) {
                          setOpened(res);
                          setFetchPhase("verified");
                        }
                      } catch (e) {
                        if (!live()) return;
                        if (e instanceof RecoveryIncompleteError) {
                          setIncomplete(e);
                          setFetchPhase("failed");
                        } else {
                          setFetchPhase("error");
                          throw e;
                        }
                      } finally {
                        onChanged();
                      }
                    })
                  }
                >
                  {r.state === "Complete" ? "Fetch the package again and retry" : "Fetch the package and rebuild the key here"}
                </button>
                {r.submitted_by.length < v.threshold && <span className="small muted">Waiting for {v.threshold - r.submitted_by.length} more.</span>}
              </div>
              {haveKey === false && (
                <p className="small ll-missing-key" data-testid="missing-recovery-key">
                  This recovery's one-time key is not in this browser. Fetch the package in the browser where you opened the recovery. Or recover
                  offline with no service: any {v.threshold} printed share cards and the offline bundle (under “Proof, mail and offline copy”) open the
                  vault.
                </p>
              )}
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
      {/* The verified letters are drawn in the full-width area under the scene,
          but this panel owns them: they unmount with it on any persona or epoch change. */}
      {opened &&
        (readingSlot
          ? createPortal(<Reveal opened={opened} personas={personas} sectionRef={openedRef} />, readingSlot)
          : <Reveal opened={opened} personas={personas} sectionRef={openedRef} />)}
    </div>
  );
}

function Reveal({ opened, personas, sectionRef }: { opened: OpenedRecovery; personas: Persona[]; sectionRef: Ref<HTMLElement> }) {
  return (
    <section className="ll-opened" ref={sectionRef} aria-labelledby="reveal-h">
      <div className="ll-reveal-head">
        <h2 id="reveal-h" className="ll-eyebrow">Verified release</h2>
        <p className="notice ok small" role="status">
          Vault key rebuilt and verified in this browser (header check passed) from the shares of {opened.used.map((t) => personaName(personas, t)).join(", ")}.
          {opened.failed.length > 0 && <> Not used: {opened.failed.map((t) => personaName(personas, t)).join(", ")}.</>}
        </p>
      </div>
      <div className="ll-reveal-grid">
        {opened.items.map((it, idx) => (
          <article className={`ll-opened-letter ${it.withheld ? "held" : "open"}`} key={it.itemId} style={{ "--i": idx } as CSSProperties}>
            <div className="ll-opened-head">
              <span className={`ll-opened-mark ${it.withheld ? "locked" : "unlocked"}`} aria-hidden="true" />
              <h3 className="ll-opened-title">{it.label}</h3>
              <span className="ll-opened-to">for {it.deliverTo.join(", ") || "anyone"}</span>
            </div>
            {it.withheld ? (
              <p className="notice small">Held online until {it.earliestRelease}. This date is online policy only.</p>
            ) : (
              <div className="secret ll-letter-body">{it.body}</div>
            )}
          </article>
        ))}
      </div>
    </section>
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
