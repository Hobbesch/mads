import { useEffect, useState } from "react";

/** "8s", "1m 04s", "1h 02m" — kompakte, mitlaufende Laufzeit. */
function fmt(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return `${m}m ${s.toString().padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${(m % 60).toString().padStart(2, "0")}m`;
}

/**
 * Zeigt die seit `since` verstrichene Zeit und tickt jede Sekunde — das
 * Lebenszeichen, das zeigt, dass der Agent arbeitet (auch wenn gerade kein neues
 * Event kommt, z.B. während der SDK-Start dauert).
 */
export function Elapsed({ since, className }: { since: number; className?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return <span className={className}>{fmt(now - since)}</span>;
}
