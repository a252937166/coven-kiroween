// Original inline art for Last Light: the lantern, wax seals and the room light.
// Every visual state follows the lifecycle state the service reported.

import type { ReactNode } from "react";
import type { VaultStatus } from "@coven/ui-kit/lastlight.ts";

export type LanternState = VaultStatus["state"] | "Unlit";

/**
 * The positioned stage that holds the room light, the lantern and the seals.
 * It is never an ancestor of the printable share card.
 */
export function LanternStage({ state, relight, children }: { state: LanternState; relight: boolean; children?: ReactNode }) {
  return (
    <div className={`ll-stage st-${state.toLowerCase()}${relight ? " relight" : ""}`}>
      <RoomLight />
      <Lantern state={state} relight={relight} />
      {children}
    </div>
  );
}

const LABEL: Record<LanternState, string> = {
  Unlit: "An unlit lantern, waiting for the vault to be made",
  Lit: "Lantern lit: the owner checked in on time",
  Flicker: "Lantern flickering: a check-in was missed",
  Vigil: "Lantern burning low through the vigil",
  Handover: "Lantern out: handover has started",
  Released: "Lantern out: the encrypted package was sent to the recovering trustee",
};

export function Lantern({ state, relight = false }: { state: LanternState; relight?: boolean }) {
  return (
    <svg
      className={`lantern s-${state.toLowerCase()}${relight ? " relight" : ""}`}
      viewBox="0 0 320 520"
      width="320"
      height="520"
      role="img"
      aria-label={LABEL[state]}
    >
      <defs>
        <linearGradient id="ll-brass" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#5b3e17" />
          <stop offset="0.28" stopColor="#c99c4f" />
          <stop offset="0.5" stopColor="#f1d28f" />
          <stop offset="0.72" stopColor="#a8783a" />
          <stop offset="1" stopColor="#4d3312" />
        </linearGradient>
        <linearGradient id="ll-brass-v" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#e5c27a" />
          <stop offset="0.5" stopColor="#9c6f30" />
          <stop offset="1" stopColor="#4d3312" />
        </linearGradient>
        <radialGradient id="ll-glass-warm" cx="50%" cy="56%" r="68%">
          <stop offset="0" stopColor="#fff3cf" />
          <stop offset="0.3" stopColor="#ffcf73" />
          <stop offset="0.68" stopColor="#d9792f" stopOpacity="0.9" />
          <stop offset="1" stopColor="#5b2516" stopOpacity="0.95" />
        </radialGradient>
        <linearGradient id="ll-glass-cold" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor="#323d63" />
          <stop offset="0.6" stopColor="#1a1f3d" />
          <stop offset="1" stopColor="#10132a" />
        </linearGradient>
        <radialGradient id="ll-glass-paper" cx="50%" cy="54%" r="70%">
          <stop offset="0" stopColor="#fff9ec" />
          <stop offset="0.45" stopColor="#f3dfb8" />
          <stop offset="1" stopColor="#6d5235" stopOpacity="0.9" />
        </radialGradient>
        <radialGradient id="ll-flame-outer" cx="50%" cy="72%" r="62%">
          <stop offset="0" stopColor="#fff2b8" />
          <stop offset="0.45" stopColor="#ffb547" />
          <stop offset="1" stopColor="#ff6a1f" stopOpacity="0.15" />
        </radialGradient>
        <radialGradient id="ll-flame-inner" cx="50%" cy="78%" r="60%">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.6" stopColor="#fff0b0" />
          <stop offset="1" stopColor="#ffd36b" />
        </radialGradient>
        <linearGradient id="ll-candle" x1="0" x2="1">
          <stop offset="0" stopColor="#cdb994" />
          <stop offset="0.45" stopColor="#f6ecd6" />
          <stop offset="1" stopColor="#b7a27c" />
        </linearGradient>
        <filter id="ll-soft" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="9" />
        </filter>
        <filter id="ll-softer" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="3" />
        </filter>
      </defs>

      {/* hanging ring and dome */}
      <circle cx="160" cy="28" r="16" fill="none" stroke="url(#ll-brass)" strokeWidth="6" />
      <rect x="152" y="42" width="16" height="16" rx="3" fill="url(#ll-brass-v)" />
      <circle cx="160" cy="62" r="7" fill="url(#ll-brass)" />
      <path d="M84 126 C 88 92 120 68 160 66 C 200 68 232 92 236 126 Z" fill="url(#ll-brass)" />
      <path d="M112 106 Q 160 86 208 106" fill="none" stroke="#3b2711" strokeWidth="3" strokeLinecap="round" opacity="0.7" />
      <circle cx="132" cy="100" r="3" fill="#2a1a0b" />
      <circle cx="160" cy="94" r="3" fill="#2a1a0b" />
      <circle cx="188" cy="100" r="3" fill="#2a1a0b" />
      <rect x="74" y="122" width="172" height="16" rx="6" fill="url(#ll-brass-v)" />

      {/* glass chamber: three light layers crossfade with the state */}
      <g className="chamber">
        <rect className="glass glass-cold" x="98" y="138" width="124" height="232" fill="url(#ll-glass-cold)" />
        <rect className="glass glass-warm" x="98" y="138" width="124" height="232" fill="url(#ll-glass-warm)" />
        <rect className="glass glass-paper" x="98" y="138" width="124" height="232" fill="url(#ll-glass-paper)" />
        <ellipse className="bloom" cx="160" cy="250" rx="58" ry="86" fill="#ffd27a" filter="url(#ll-soft)" />

        <rect x="140" y="300" width="40" height="70" rx="4" fill="url(#ll-candle)" />
        <ellipse cx="160" cy="300" rx="20" ry="4" fill="#fbf3e2" />
        <path d="M147 300 q 3 11 0 19 q -2 6 2 9" fill="none" stroke="#efe2c4" strokeWidth="4" strokeLinecap="round" />
        <line x1="160" y1="300" x2="160" y2="288" stroke="#2a1a0c" strokeWidth="2.5" strokeLinecap="round" />

        <g className="flame">
          <g className="flame-ignite">
          <g className="flame-move">
            <path
              className="flame-outer"
              d="M160 204 C 172 226 186 246 184 266 C 182 284 170 292 160 292 C 150 292 138 284 136 266 C 134 246 148 226 160 204 Z"
              fill="url(#ll-flame-outer)"
            />
            <path
              className="flame-inner"
              d="M160 230 C 168 245 175 258 173 270 C 171 282 166 287 160 287 C 154 287 149 282 147 270 C 145 258 152 245 160 230 Z"
              fill="url(#ll-flame-inner)"
            />
            <ellipse className="flame-core" cx="160" cy="281" rx="6" ry="8" fill="#a9c6ff" opacity="0.85" />
          </g>
          </g>
        </g>

        <g className="ember">
          <circle cx="160" cy="287" r="8" fill="#ff7a3a" opacity="0.35" filter="url(#ll-softer)" />
          <circle cx="160" cy="287" r="2.8" fill="#ff8b45" />
        </g>
        <g className="smoke" fill="none" strokeLinecap="round">
          <path className="wisp w1" d="M160 284 C 150 268 172 252 160 236 C 150 222 168 208 158 192" />
          <path className="wisp w2" d="M161 284 C 172 266 150 250 163 232 C 174 216 154 204 165 186" />
        </g>
        <g className="letter-glyph">
          <rect x="128" y="226" width="64" height="88" rx="3" fill="#fbf4e4" />
          <path d="M138 246 h44 M138 258 h44 M138 270 h30" stroke="#b49b74" strokeWidth="3" strokeLinecap="round" />
          <circle cx="160" cy="296" r="9" fill="#b2402a" />
          <circle cx="160" cy="296" r="5" fill="none" stroke="#e98a62" strokeWidth="1.5" />
        </g>

        <path className="streak" d="M106 150 L126 150 L106 214 Z" fill="#ffffff" />
        <path className="streak faint" d="M108 228 L116 228 L106 262 Z" fill="#ffffff" />
        <rect x="212" y="150" width="2" height="206" fill="#ffffff" opacity="0.08" />
      </g>

      {/* frame */}
      <rect x="86" y="134" width="14" height="240" rx="5" fill="url(#ll-brass-v)" />
      <rect x="220" y="134" width="14" height="240" rx="5" fill="url(#ll-brass-v)" />
      <rect x="92" y="135" width="136" height="7" rx="2" fill="#7c5823" />
      <rect x="92" y="365" width="136" height="7" rx="2" fill="#7c5823" />
      <path d="M70 372 H250 L238 398 H82 Z" fill="url(#ll-brass)" />
      <rect x="94" y="398" width="132" height="18" rx="5" fill="url(#ll-brass-v)" />
      <rect x="104" y="414" width="18" height="10" rx="2" fill="#4d3312" />
      <rect x="198" y="414" width="18" height="10" rx="2" fill="#4d3312" />
    </svg>
  );
}

/** Room light behind the lantern: halo, cold moonlight, dust in the beam, floor glow and the relight bloom. */
export function RoomLight() {
  return (
    <>
      <span className="ll-halo" aria-hidden="true" />
      <span className="ll-halo-cold" aria-hidden="true" />
      <span className="ll-moon" aria-hidden="true" />
      <span className="ll-motes" aria-hidden="true">
        {Array.from({ length: 9 }, (_, i) => (
          <span key={i} className={`ll-mote m${i}`} />
        ))}
      </span>
      <span className="ll-floor" aria-hidden="true" />
      <span className="ll-flash" aria-hidden="true" />
    </>
  );
}

/** A wax seal for one keeper. It glows only once that keeper's share has arrived. */
export function Seal({ letter, lit, stamped }: { letter: string; lit: boolean; stamped: boolean }) {
  return (
    <span className={`ll-seal${lit ? " lit" : ""}${stamped ? " stamped" : ""}`} aria-hidden="true">
      <svg viewBox="0 0 64 64" width="52" height="52">
        <path
          className="wax"
          d="M32 4 C 40 3 46 7 52 10 C 58 15 61 22 60 30 C 62 38 59 45 54 51 C 48 57 41 60 32 60 C 23 61 16 58 10 52 C 5 46 3 38 4 30 C 3 22 6 15 12 10 C 18 6 25 3 32 4 Z"
        />
        <circle className="ring" cx="32" cy="32" r="19" />
        <path className="sheen" d="M16 22 C 20 14 28 10 36 11" />
        <text className="initial" x="32" y="39.5" textAnchor="middle">
          {letter}
        </text>
      </svg>
    </span>
  );
}
