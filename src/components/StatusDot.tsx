import { STATUS_META } from "../status";
import type { AgentStatus } from "../../shared/protocol";

export function StatusDot({ status }: { status: AgentStatus }) {
  const m = STATUS_META[status];
  return <span className={`dot${m.pulse ? " pulse" : ""}`} style={{ background: m.color }} title={m.label} />;
}
