// Original inline instrument for Break Glass: the relay from the requester's
// petition key through the approval cells to the aperture that guards one
// sealed item. Every visual state follows what the service reported for the
// petition, or a decrypt this browser verified. Nothing here invents progress.

import { useId, type CSSProperties } from "react";

export type RelayMode = "idle" | "open" | "approved" | "released" | "opened" | "expired" | "denied" | "invalidated";

const W = 760;
const Y = 104;
const KEY_X = 52;
const KEY_R = 24;
const CELL_W = 112;
const CELL_H = 58;
const MAX_CELLS = 4;
const AP_X = 640;
const AP_R = 82;
const BLADE_R = 72;
/** Where the release run plugs into the aperture's dial. */
const LEAD_END = AP_X - AP_R - 12;

const STATUS: Record<RelayMode, (a: number, t: number) => string> = {
  idle: () => "Sealed. Nothing opens until a quorum approves one petition.",
  open: (a, t) => `Sealed. ${a} of ${t} approvals so far.`,
  approved: () => "Quorum reached. Sealed until the requester retrieves it in their own browser.",
  released: () => "Package sent to the requester. It opens only in the requester's browser.",
  opened: () => "Open in this browser, for this one item.",
  expired: () => "Path cut: the retrieval window ended.",
  denied: () => "Path cut: the petition was denied.",
  invalidated: () => "Path cut: the item was resealed.",
};

const pt = (deg: number, r: number) => {
  const a = (deg * Math.PI) / 180;
  return [AP_X + r * Math.cos(a), Y + r * Math.sin(a)] as const;
};

/** Six iris blades. Each pivots on the rim; opening swings it out of the centre. */
const BLADES = Array.from({ length: 6 }, (_, i) => {
  const t = i * 60 - 90;
  const [px, py] = pt(t, BLADE_R);
  const [ax, ay] = pt(t + 78, BLADE_R);
  const [bx, by] = pt(t + 180, 12);
  return { d: `M${px} ${py} A${BLADE_R} ${BLADE_R} 0 0 1 ${ax} ${ay} L${bx} ${by} Z`, origin: `${px}px ${py}px` };
});

const TICKS = Array.from({ length: 24 }, (_, i) => {
  const [x1, y1] = pt(i * 15 - 90, AP_R + 16);
  const [x2, y2] = pt(i * 15 - 90, AP_R + (i % 6 === 0 ? 24 : 20));
  return { x1, y1, x2, y2, major: i % 6 === 0 };
});

export function Relay(props: {
  mode: RelayMode;
  threshold: number;
  approvals: number;
  /** First names of the approvers, in the order their approvals were recorded. */
  names: string[];
  /** 1-based cells whose approval the service just confirmed. */
  pulse: ReadonlySet<number>;
  /** Fraction of the retrieval window left by the service clock, or null when it does not apply. */
  windowLeft: number | null;
  windowText?: string;
}) {
  const { mode, threshold, names, windowLeft, windowText } = props;
  const uid = useId().replace(/:/g, "");
  const T = Math.max(1, threshold);
  const approvals = Math.min(props.approvals, T);
  const quorum = approvals >= T;
  const cut = mode === "expired" || mode === "denied" || mode === "invalidated";
  // Up to four approvals get one connected cell each. Larger quorums collapse
  // into one counter cell with explicit "k of T" text, so nothing overlaps.
  const compact = T > MAX_CELLS;
  const n = compact ? 1 : T; // cells drawn
  const cw = compact ? 300 : T <= 3 ? CELL_W : 82;
  // Four cells: equal runs between key, cells and the dial, so any run can show a cut.
  const run4 = (LEAD_END - (KEY_X + KEY_R) - 4 * 82) / 5;
  const [x0, x1] = compact
    ? [304, 304]
    : T <= 3
      ? [168, 446]
      : [KEY_X + KEY_R + run4 + 41, KEY_X + KEY_R + run4 + 41 + 3 * (82 + run4)];
  const cellX = (j: number) => (n === 1 ? (x0 + x1) / 2 : x0 + ((j - 1) * (x1 - x0)) / (n - 1));
  const litCells = compact ? (approvals > 0 ? 1 : 0) : approvals;
  // The segment that is visibly cut: the first one not yet lit, or the release run when quorum was reached.
  const cutAt = cut ? (quorum ? n + 1 : Math.min(litCells + 1, n + 1)) : null;
  const right = (j: number) => (j === 0 ? KEY_X + KEY_R : cellX(j) + cw / 2);
  const left = (j: number) => (j === n + 1 ? LEAD_END : cellX(j) - cw / 2);
  const segs = Array.from({ length: n + 1 }, (_, i) => {
    const j = i + 1;
    const lit = j <= n ? j <= litCells && !(compact && cut && !quorum && j === cutAt) : quorum && !cut;
    return { k: j, a: right(j - 1), b: left(j), lit, release: j === n + 1 };
  });
  const pulse = new Set([...props.pulse].map((i) => (compact ? 1 : i)));
  const quorumPulse = props.pulse.has(T) && quorum;
  const label = STATUS[mode](approvals, T);
  const win = windowLeft === null ? null : Math.max(0, Math.min(1, windowLeft));
  const pad = cw < CELL_W ? 10 : 12;

  return (
    <figure className={`bg-relay m-${mode}${quorum ? " quorum" : ""}`}>
      <svg viewBox={`0 0 ${W} 214`} width={W} height={214} role="img" aria-label={`Release path. ${label}`}>
        <defs>
          <radialGradient id={`${uid}-core`} cx="50%" cy="50%" r="50%">
            <stop offset="0" stopColor="#fff2d2" />
            <stop offset="0.35" stopColor="#ffbf5c" />
            <stop offset="0.75" stopColor="#c8611f" stopOpacity="0.55" />
            <stop offset="1" stopColor="#0a1c22" stopOpacity="0" />
          </radialGradient>
          <linearGradient id={`${uid}-blade`} x1="0" x2="1" y1="0" y2="1">
            <stop offset="0" stopColor="#3b5966" />
            <stop offset="0.55" stopColor="#1d3540" />
            <stop offset="1" stopColor="#10242c" />
          </linearGradient>
          <clipPath id={`${uid}-clip`}>
            <circle cx={AP_X} cy={Y} r={BLADE_R} />
          </clipPath>
        </defs>

        {/* requester key: the start of the path (0 approvals) */}
        <g className="node key">
          <circle cx={KEY_X} cy={Y} r={KEY_R} className="node-ring" />
          <circle cx={KEY_X - 6} cy={Y} r={7} className="key-bow" />
          <path d={`M${KEY_X + 1} ${Y} H${KEY_X + 15} M${KEY_X + 10} ${Y} v6 M${KEY_X + 15} ${Y} v5`} className="key-bit" />
          <text x={KEY_X} y={Y + 46} textAnchor="middle" className="cap">requester key</text>
        </g>

        {segs.map((s) => {
          const mid = (s.a + s.b) / 2;
          const isCut = cutAt === s.k;
          const after = cutAt !== null && s.k > cutAt;
          // The break mark fits inside its run, however short the run is.
          const g = Math.min(9, Math.max(3, (s.b - s.a) / 2 - 9));
          return (
            <g key={s.k} className={`seg${s.lit ? " lit" : ""}${s.release ? " release" : ""}${isCut ? " cut" : ""}${after ? " dead" : ""}`}>
              {isCut ? (
                <>
                  <line x1={s.a} y1={Y} x2={mid - g} y2={Y} className="run" />
                  <line x1={mid + g} y1={Y} x2={s.b} y2={Y} className="run" />
                  <path d={`M${mid - g - 5} ${Y - 10} L${mid - g + 1} ${Y + 10} M${mid + g - 1} ${Y - 10} L${mid + g + 5} ${Y + 10}`} className="break" />
                  <text x={mid} y={Y - 18} textAnchor="middle" className="cap cut-cap">cut</text>
                </>
              ) : (
                <line x1={s.a} y1={Y} x2={s.b} y2={Y} className="run" />
              )}
              {!isCut && ((s.k <= T && pulse.has(s.k)) || (s.release && quorumPulse)) && (
                <line
                  x1={s.a}
                  y1={Y}
                  x2={s.b}
                  y2={Y}
                  className="pulse"
                  pathLength={100}
                  style={{ animationDelay: s.release ? "0.75s" : "0s" } as CSSProperties}
                />
              )}
            </g>
          );
        })}

        {compact ? (
          <g className={`cell counter${quorum ? " lit" : approvals > 0 ? " part" : ""}${pulse.has(1) ? " fresh" : ""}`}>
            <rect x={cellX(1) - cw / 2} y={Y - CELL_H / 2} width={cw} height={CELL_H} rx={12} className="cell-box" />
            <text x={cellX(1) - cw / 2 + pad} y={Y - 9} className="cap">{`quorum · ${T} approvals`}</text>
            <text x={cellX(1) - cw / 2 + pad} y={Y + 15} className="cell-name">{`${approvals} of ${T} approved`}</text>
            {T <= 12 &&
              Array.from({ length: T }, (_, i) => (
                <rect key={i} x={cellX(1) + 18 + i * 9} y={Y + 5} width={6} height={12} rx={1.5} className={`notch${i < approvals ? " on" : ""}`} />
              ))}
          </g>
        ) : (
          Array.from({ length: T }, (_, i) => {
            const k = i + 1;
            const lit = k <= approvals;
            const cx = cellX(k);
            return (
              <g key={k} className={`cell${lit ? " lit" : ""}${pulse.has(k) ? " fresh" : ""}${cutAt !== null && k >= cutAt && !lit ? " dead" : ""}`}>
                <rect x={cx - cw / 2} y={Y - CELL_H / 2} width={cw} height={CELL_H} rx={12} className="cell-box" />
                <text x={cx - cw / 2 + pad} y={Y - 9} className="cap">{k === T ? `${k} · quorum` : `${k}`}</text>
                <text x={cx - cw / 2 + pad} y={Y + 15} className="cell-name">
                  {lit ? `✓ ${names[i] ?? "approved"}` : cutAt !== null && k >= cutAt ? "—" : "waiting"}
                </text>
              </g>
            );
          })
        )}

        {/* the aperture: dial ticks, retrieval-window arc, iris over the sealed core */}
        <g className="aperture">
          {TICKS.map((t, i) => (
            <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} className={`tick${t.major ? " major" : ""}`} />
          ))}
          <circle cx={AP_X} cy={Y} r={AP_R + 8} className="win-track" />
          {win !== null && win > 0 && (
            <circle
              cx={AP_X}
              cy={Y}
              r={AP_R + 8}
              className={`win${win < 0.2 ? " low" : ""}`}
              pathLength={100}
              strokeDasharray={`${(win * 100).toFixed(2)} 100`}
              transform={`rotate(-90 ${AP_X} ${Y})`}
            />
          )}
          <circle cx={AP_X} cy={Y} r={AP_R} className="rim" />
          <circle cx={AP_X} cy={Y} r={BLADE_R} className="core" fill={`url(#${uid}-core)`} />
          <g className="core-key">
            <circle cx={AP_X - 9} cy={Y} r={9} />
            <path d={`M${AP_X} ${Y} H${AP_X + 20} M${AP_X + 13} ${Y} v7 M${AP_X + 20} ${Y} v6`} />
          </g>
          <g className="blades" clipPath={`url(#${uid}-clip)`}>
            {BLADES.map((b, i) => (
              <path key={i} d={b.d} className="blade" fill={`url(#${uid}-blade)`} style={{ transformOrigin: b.origin } as CSSProperties} />
            ))}
          </g>
          <circle cx={AP_X} cy={Y} r={BLADE_R} className="rim-inner" />
          {cut && <path d={`M${AP_X - 46} ${Y + 46} L${AP_X + 46} ${Y - 46}`} className="bar" />}
        </g>
      </svg>
      <figcaption className="bg-relay-status">
        <span className="bg-relay-dot" aria-hidden="true" />
        {label}
        {windowText && <span className="bg-relay-window tnum"> · {windowText}</span>}
      </figcaption>
    </figure>
  );
}
