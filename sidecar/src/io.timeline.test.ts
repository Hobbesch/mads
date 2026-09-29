import { describe, it, expect } from "vitest";
import { send, timelineSnapshot, forgetTimeline } from "./io.js";

describe("timelineSnapshot", () => {
  it("begrenzt den Replay auf ein Byte-Budget und behält die neuesten Events", async () => {
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
    expect(tl.length).toBeLessThan(30);
    expect(JSON.stringify(tl).length).toBeLessThan(700 * 1024);
    expect(tl[tl.length - 1].i).toBe(29);
    forgetTimeline(id);
  });
});
