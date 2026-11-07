// Original inline lantern illustration. Its drawing follows the real lifecycle state.

import type { VaultStatus } from "@coven/ui-kit/lastlight.ts";

type State = VaultStatus["state"];

const LABEL: Record<State, string> = {
  Lit: "Lantern lit",
  Flicker: "Lantern flickering",
  Vigil: "Lantern burning low through the vigil",
  Handover: "Lantern out: handover has started",
  Released: "Lantern out: the encrypted package was sent to the recovering trustee",
};

export function Lantern({ state }: { state: State }) {
  const flame = state === "Lit" || state === "Flicker" || state === "Vigil";
  const glow = { Lit: 0.55, Flicker: 0.35, Vigil: 0.16, Handover: 0, Released: 0 }[state];
  const flameScale = state === "Vigil" ? 0.6 : 1;
  return (
    <svg className={`lantern lantern-${state.toLowerCase()}`} viewBox="0 0 140 180" role="img" aria-label={LABEL[state]}>
      <defs>
        <radialGradient id="ll-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#D9A44D" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#D9A44D" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="70" cy="98" r="62" fill="url(#ll-glow)" opacity={glow} />
      {state === "Vigil" && <path d="M114 20a12 12 0 1 0 8 21 10 10 0 1 1-8-21z" fill="#49616F" opacity="0.7" />}
      {/* handle and cap */}
      <path d="M56 30a14 14 0 0 1 28 0" fill="none" stroke="#202B3D" strokeWidth="3" />
      <path d="M46 44h48l-8-12H54z" fill="#202B3D" />
      {/* glass */}
      <rect x="44" y="46" width="52" height="86" rx="6" fill={flame ? "#FBF3E2" : "#E3EBED"} stroke="#202B3D" strokeWidth="3" />
      <path d="M70 46v86M44 89h52" stroke="#202B3D" strokeWidth="1.5" opacity="0.35" />
      {flame && (
        <g className="flame" transform={`translate(70 112) scale(${flameScale}) translate(-70 -112)`}>
          <path d="M70 76c9 12 13 20 13 28a13 13 0 0 1-26 0c0-8 4-16 13-28z" fill="#D9A44D" />
          <path d="M70 92c4 6 6 10 6 14a6 6 0 0 1-12 0c0-4 2-8 6-14z" fill="#FBFDFD" opacity="0.75" />
        </g>
      )}
      {state === "Handover" && <circle cx="70" cy="114" r="3" fill="#49616F" />}
      {state === "Released" && (
        <g>
          <rect x="54" y="98" width="32" height="22" rx="2" fill="#FBFDFD" stroke="#244D62" strokeWidth="2" />
          <path d="M54 99l16 12 16-12" fill="none" stroke="#244D62" strokeWidth="2" />
        </g>
      )}
      {/* base */}
      <path d="M40 132h60l-6 12H46z" fill="#202B3D" />
      <rect x="52" y="144" width="36" height="6" rx="2" fill="#202B3D" />
    </svg>
  );
}

/** Original folio illustration for the first run: a sealed letter. */
export function SealedLetter() {
  return (
    <svg className="sealed-letter" viewBox="0 0 220 150" role="img" aria-label="A sealed family letter">
      <rect x="10" y="20" width="200" height="120" rx="6" fill="#FBFDFD" stroke="#202B3D" strokeWidth="2.5" />
      <path d="M10 26l100 66 100-66" fill="none" stroke="#202B3D" strokeWidth="2.5" />
      <path d="M28 120h70M28 108h48" stroke="#49616F" strokeWidth="2" opacity="0.6" />
      <circle cx="110" cy="92" r="17" fill="#D9A44D" stroke="#202B3D" strokeWidth="2" />
      <path d="M103 92l5 5 9-10" fill="none" stroke="#202B3D" strokeWidth="2.4" />
    </svg>
  );
}
