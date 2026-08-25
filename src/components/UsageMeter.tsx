/**
 * Plan-Nutzungslimits eines Claude-Kontos als kompakte Balken (5-Stunden- und Wochenfenster).
 *
 * Zweck: das Limit KOMMEN sehen, statt es beim Anschlag zu bemerken. Die Zahlen stammen aus der
 * Usage-Abfrage des SDK (`account_usage`) und decken sich mit den „Plan-Nutzungslimits" in den
 * Claude-Apps. Bewusst nur die beiden Fenster, die im Alltag binden — das Opus-Wochenfenster nur,
 * wenn es überhaupt gemeldet und nennenswert ausgelastet ist.
 */
import type { UsageWindow } from "../../shared/protocol";

/** Ab hier wird der Balken warnend eingefärbt bzw. als kritisch markiert. */
const WARN_AT = 75;
const CRIT_AT = 95;

function resetLabel(resetsAt?: number): string {
  if (!resetsAt) return "";
  const diffMin = Math.round((resetsAt - Date.now()) / 60_000);
  if (diffMin <= 0) return "jetzt";
  if (diffMin < 60) return `in ${diffMin} Min.`;
  const d = new Date(resetsAt);
  const time = d.toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit" });
  // Innerhalb der nächsten 24 h reicht die Uhrzeit; darüber hinaus den Wochentag dazu.
  if (diffMin < 24 * 60) return time;
  return `${d.toLocaleDateString("de-CH", { weekday: "short" })}, ${time}`;
}

function Bar({ label, win }: { label: string; win: UsageWindow }) {
  const pct = Math.max(0, Math.min(100, Math.round(win.utilization ?? 0)));
  const tone = pct >= CRIT_AT ? "crit" : pct >= WARN_AT ? "warn" : "ok";
  const reset = resetLabel(win.resetsAt);
  return (
    <div className="usage-row" title={`${label}: ${pct}% verbraucht${reset ? ` · Zurücksetzung ${reset}` : ""}`}>
      <span className="usage-label">{label}</span>
      <span className="usage-track">
        <span className={`usage-fill ${tone}`} style={{ width: `${pct}%` }} />
      </span>
      <span className={`usage-pct ${tone}`}>{pct}%</span>
      {reset && <span className="usage-reset">{reset}</span>}
    </div>
  );
}

export function UsageMeter({
  usage,
}: {
  usage?: { fiveHour?: UsageWindow; sevenDay?: UsageWindow; sevenDayOpus?: UsageWindow };
}) {
  if (!usage) return null;
  const rows: Array<{ label: string; win: UsageWindow }> = [];
  if (usage.fiveHour) rows.push({ label: "5 Std.", win: usage.fiveHour });
  if (usage.sevenDay) rows.push({ label: "Woche", win: usage.sevenDay });
  // Opus-Wochenfenster nur zeigen, wenn es real ins Gewicht fällt — sonst ist es nur Rauschen.
  if (usage.sevenDayOpus && (usage.sevenDayOpus.utilization ?? 0) >= WARN_AT) {
    rows.push({ label: "Woche · Opus", win: usage.sevenDayOpus });
  }
  if (!rows.length) return null;
  return (
    <div className="usage-meter">
      {rows.map((r) => (
        <Bar key={r.label} label={r.label} win={r.win} />
      ))}
    </div>
  );
}
