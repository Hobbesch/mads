/**
 * Orchestrator — verwaltet den Agenten-Pool und routet HostMessages.
 * (MVP-Stand: Worktree-Anlage, Concurrency-Cap, Eskalations-Heuristik und
 *  Session-Resume kommen gemäß Roadmap P3–P7 dazu — docs/design/01-architecture.md §10.)
 */
import { AgentSession } from "./session.js";
import { log } from "./io.js";
import type { HostMessage } from "../../shared/protocol.js";

export class Orchestrator {
  private readonly pool = new Map<string, AgentSession>();

  async dispatch(msg: HostMessage): Promise<void> {
    switch (msg.type) {
      case "start_agent": {
        if (this.pool.has(msg.agentId)) {
          log(`[orchestrator] agent ${msg.agentId} existiert bereits`);
          return;
        }
        const session = new AgentSession(msg.agentId);
        this.pool.set(msg.agentId, session);
        await session.start(msg);
        break;
      }
      case "send_input":
        this.pool.get(msg.agentId)?.sendInput(msg.text);
        break;
      case "answer_permission":
        this.pool.get(msg.agentId)?.answerPermission(msg.requestId, msg.decision);
        break;
      case "interrupt_agent":
        await this.pool.get(msg.agentId)?.interrupt();
        break;
      case "set_permission_mode":
        await this.pool.get(msg.agentId)?.setMode(msg.mode);
        break;
      case "stop_agent": {
        const s = this.pool.get(msg.agentId);
        s?.stop();
        this.pool.delete(msg.agentId);
        break;
      }
      case "shutdown":
        for (const s of this.pool.values()) s.stop();
        this.pool.clear();
        process.exit(0);
        break;
      default:
        log("[orchestrator] unbekannter HostMessage-Typ", JSON.stringify(msg));
    }
  }
}
