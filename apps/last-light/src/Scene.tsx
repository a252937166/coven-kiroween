// Original local art for Last Light's key reconstruction scene: a stacked
// graphite vault block with a lock that turns into a check. These are shapes
// only. The caller picks the phase from service data, or from a recovery this
// browser verified; CSS on the stage's phase class moves the plates. The orbit
// is decorative only: it shows no state and pauses offscreen or when hidden.

import { useRef } from "react";
import { useInView } from "@coven/ui-kit/motion.ts";

/** The vault block at the end of the trustee tracks. */
export function VaultCore({ title, caption }: { title: string; caption: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const live = useInView(ref);
  return (
    <div className="ll-core" ref={ref}>
      <span className={`ll-orbit${live ? "" : " paused"}`} aria-hidden="true" />
      <span className="ll-plate p1" />
      <span className="ll-plate p2" />
      {/* Decorative event layers: the mint seam light of a verified opening and the quorum shockwave. */}
      <span className="ll-seam" />
      <span className="ll-plate p3" />
      <span className="ll-shock" />
      <span className="ll-core-ring" />
      <div className="ll-core-center">
        <span className="ll-lock">
          <span className="ll-lock-shape" />
          <span className="ll-lock-shut" />
        </span>
        <b className="ll-core-title">{title}</b>
        <small className="ll-core-caption">{caption}</small>
      </div>
    </div>
  );
}
