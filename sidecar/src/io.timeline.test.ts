// Snapshot-Replay ist EINE WebSocket-Nachricht: timelineSnapshot muss auf ein Byte-Budget begrenzen
// und dabei die NEUESTEN Events behalten (sonst „Message too long" beim iOS-Client).
import { send, timelineSnapshot, forgetTimeline } from "./io.js";

let failed = 0;
function check(name: string, cond: boolean): void {
  if (!cond) failed++;
  console.log(cond ? "PASS" : "FAIL", name);
}

const id = "agent-budget";
const payload = "x".repeat(100_000);
const origWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (() => true) as typeof process.stdout.write;
try {
  for (let i = 0; i < 30; i++) await send({ type: "agent_event", agentId: id, event: { i, payload } });
} finally {
  process.stdout.write = origWrite;
}
const tl = timelineSnapshot(id) as { i: number }[];
check("Replay ist gekürzt", tl.length < 30);
check("Replay bleibt unter dem Nachrichtenlimit", JSON.stringify(tl).length < 700 * 1024);
check("neuestes Event bleibt erhalten", tl[tl.length - 1]?.i === 29);
forgetTimeline(id);
if (failed) process.exit(1);
