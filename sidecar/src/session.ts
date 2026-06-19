/**
 * AgentSession — kapselt EINEN Claude-Code-Agenten.
 *
 * Zwei Betriebsarten:
 *  - real:  Claude Agent SDK query() im Streaming-Input-Modus (dynamisch importiert,
 *           damit fehlende Auth/SDK nur reale Agenten betrifft, nicht den Mock).
 *  - mock:  scripted Stream ohne SDK/Auth — demonstriert das gesamte UI inkl.
 *           Permission-Loop, bevor der Nutzer eingeloggt ist.
 *
 * Siehe docs/research/sidecar-orchestration.md §1.2/§2/§4 und
 * docs/research/claude-code-capabilities.md §5/§9.
 */
import { AsyncQueue } from "./async-queue.js";
import { send, log, envelope, randomUUID } from "./io.js";
import { createWorktree, removeWorktree } from "./git.js";
import type {
  StartAgentMsg,
  PermissionDecision,
  AgentStatus,
} from "../../shared/protocol.js";

// Loses SDK-Typing: die exakte API entwickelt sich (0.3.x). Wir casten defensiv.
type PermissionResult =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message: string; interrupt?: boolean };

interface SdkUserMessage {
  type: "user";
  message: { role: "user"; content: string };
  parent_tool_use_id: null;
  session_id?: string;
}

interface QueryHandle extends AsyncIterable<unknown> {
  interrupt?: () => Promise<void>;
  setPermissionMode?: (mode: string) => Promise<void>;
  close?: () => void;
}

function userMsg(text: string): SdkUserMessage {
  return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
}

export class AgentSession {
  readonly agentId: string;
  status: AgentStatus = "starting";
  sessionId?: string;
  costUsd = 0;
  numTurns = 0;
  // P3: gesetzt, sobald ein Worktree für diesen Agenten existiert.
  repoRoot?: string;
  branch?: string;
  worktreePath?: string;
  // P7: UI-Kontext für Persistenz/Resume.
  label?: string;
  role?: "integrator" | "sub";
  model?: string;
  lastPrompt?: string;
  mock = false;

  private readonly inbox = new AsyncQueue<SdkUserMessage>();
  private readonly pending = new Map<string, (r: PermissionResult) => void>();
  private q?: QueryHandle;
  private readonly onChange?: () => void;

  constructor(agentId: string, onChange?: () => void) {
    this.agentId = agentId;
    this.onChange = onChange;
  }

  // --------------------------------------------------------------------------
  async start(msg: StartAgentMsg): Promise<void> {
    this.mock = msg.mock ?? false;
    this.repoRoot = msg.repoRoot;
    this.branch = msg.branch;
    this.label = msg.label;
    this.role = msg.role;
    this.model = msg.model;
    this.lastPrompt = msg.prompt;
    this.inbox.push(userMsg(msg.prompt));
    this.setStatus("running", "starting up");

    if (this.mock) {
      void this.runMock(msg.prompt);
      return;
    }

    // P3: isolierten Worktree anlegen; P7: bei Resume vorhandenen weiterverwenden.
    let cwd = msg.cwd ?? process.cwd();
    if (msg.resumeWorktreePath) {
      this.worktreePath = msg.resumeWorktreePath;
      cwd = msg.resumeWorktreePath;
    } else if (msg.repoRoot && msg.branch) {
      const baseRef = msg.baseRef ?? "origin/main";
      const wt = await createWorktree(msg.repoRoot, this.agentId, msg.branch, baseRef);
      if (!wt.ok) {
        this.fail("spawn_failed", `Worktree-Anlage fehlgeschlagen: ${wt.error}`, true);
        return;
      }
      this.worktreePath = wt.path;
      cwd = wt.path;
      this.emit({ ...envelope(), type: "worktree_created", agentId: this.agentId, path: wt.path, branch: msg.branch, baseRef });
    }

    try {
      const sdk = (await import("@anthropic-ai/claude-agent-sdk")) as {
        query: (args: { prompt: AsyncIterable<SdkUserMessage>; options: Record<string, unknown> }) => QueryHandle;
      };

      this.q = sdk.query({
        prompt: this.inbox,
        options: {
          cwd,
          model: msg.model,
          permissionMode: msg.permissionMode ?? "default",
          includePartialMessages: false,
          allowedTools: msg.allowedTools,
          disallowedTools: msg.disallowedTools,
          resume: msg.resumeSessionId,
          forkSession: msg.forkSession,
          stderr: (d: string) => log(`[claude ${this.agentId}]`, d),
          canUseTool: (toolName: string, input: Record<string, unknown>, opts: Record<string, unknown>) =>
            this.onCanUseTool(toolName, input, opts),
          hooks: {
            Notification: [
              {
                hooks: [
                  async (inp: { message?: string }) => {
                    const m = inp?.message ?? "";
                    this.emit({
                      ...envelope(),
                      type: "needs_input",
                      agentId: this.agentId,
                      reason: /permission/i.test(m) ? "permission_prompt" : "idle_prompt",
                      message: m,
                    });
                    return {};
                  },
                ],
              },
            ],
          },
        },
      });

      void this.consume();
    } catch (e) {
      this.fail("spawn_failed", `Konnte Agent SDK nicht starten: ${String(e)}`, true);
    }
  }

  // --------------------------------------------------------------------------
  private onCanUseTool(
    toolName: string,
    input: Record<string, unknown>,
    opts: Record<string, unknown>,
  ): Promise<PermissionResult> {
    return new Promise<PermissionResult>((resolve) => {
      const requestId = randomUUID();
      this.pending.set(requestId, resolve);
      const isAsk = toolName === "AskUserQuestion";
      this.emit({
        ...envelope(),
        type: "permission_request",
        agentId: this.agentId,
        requestId,
        toolName,
        input,
        kind: isAsk ? "ask_user_question" : "tool",
        questions: isAsk ? (input as { questions?: unknown }).questions : undefined,
        blockedPath: opts.blockedPath as string | undefined,
        decisionReason: opts.decisionReason as string | undefined,
      });
      this.setStatus("waiting_input", `permission: ${toolName}`);
    });
  }

  answerPermission(requestId: string, decision: PermissionDecision): void {
    const resolve = this.pending.get(requestId);
    if (!resolve) {
      log(`[${this.agentId}] unknown requestId`, requestId);
      return;
    }
    this.pending.delete(requestId);
    if (decision.behavior === "allow") {
      resolve({ behavior: "allow", updatedInput: decision.updatedInput });
    } else if (decision.behavior === "answer_questions") {
      resolve({
        behavior: "allow",
        updatedInput: { answers: decision.answers, response: decision.response },
      });
    } else {
      resolve({ behavior: "deny", message: decision.message, interrupt: decision.interrupt });
    }
    this.setStatus("running");
    if (this.mock) void this.mockAfterPermission();
  }

  sendInput(text: string): void {
    this.inbox.push(userMsg(text));
    this.setStatus("running");
    if (this.mock) void this.runMock(text);
  }

  async interrupt(): Promise<void> {
    await this.q?.interrupt?.();
    this.setStatus("paused");
  }

  async setMode(mode: string): Promise<void> {
    await this.q?.setPermissionMode?.(mode);
  }

  async stop(removeWt = false): Promise<void> {
    this.inbox.close();
    this.q?.close?.();
    if (removeWt && this.repoRoot && this.worktreePath) {
      try {
        await removeWorktree(this.repoRoot, this.worktreePath, this.branch);
      } catch (e) {
        log(`[${this.agentId}] worktree cleanup failed:`, String(e));
      }
    }
  }

  // --------------------------------------------------------------------------
  private async consume(): Promise<void> {
    if (!this.q) return;
    try {
      for await (const raw of this.q) {
        const m = raw as Record<string, unknown>;
        switch (m.type) {
          case "system":
            if (m.subtype === "init") {
              this.sessionId = m.session_id as string;
              this.onChange?.();
            }
            break;
          case "assistant": {
            const content = ((m.message as { content?: unknown[] })?.content ?? []) as Array<Record<string, unknown>>;
            for (const block of content) {
              if (block.type === "text") {
                this.emit({ ...envelope(), type: "agent_event", agentId: this.agentId, event: { kind: "assistant_text", text: String(block.text) } });
              } else if (block.type === "tool_use") {
                this.emit({ ...envelope(), type: "agent_event", agentId: this.agentId, event: { kind: "tool_use", toolUseId: String(block.id), name: String(block.name), input: (block.input ?? {}) as Record<string, unknown> } });
                this.setStatus("running", String(block.name));
              }
            }
            break;
          }
          case "result": {
            this.costUsd = Number(m.total_cost_usd ?? 0);
            this.numTurns = Number(m.num_turns ?? 0);
            this.emitCost();
            this.emit({
              ...envelope(),
              type: "agent_done",
              agentId: this.agentId,
              subtype: (m.subtype as "success") ?? "success",
              sessionId: (m.session_id as string) ?? this.sessionId,
              resultText: m.result as string | undefined,
              totalCostUsd: this.costUsd,
              numTurns: this.numTurns,
              isError: Boolean(m.is_error),
            });
            this.setStatus(m.is_error ? "error" : "done");
            break;
          }
          default:
            break; // defensiv: unbekannte Event-Typen tolerieren
        }
      }
    } catch (e) {
      this.fail("consume_failed", `Stream-Fehler: ${String(e)}`, false);
    }
  }

  // ---------------------------- Mock-Modus ----------------------------------
  private async runMock(prompt: string): Promise<void> {
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    this.sessionId = this.sessionId ?? `mock-${this.agentId}`;
    await delay(300);
    this.emitText(`Verstanden. Ich bearbeite: "${prompt}".`);
    await delay(500);
    this.emitText("Ich sehe mir zuerst die Projektstruktur an.");
    this.emitToolUse("Bash", { command: "git status" });
    await delay(600);
    this.setStatus("running", "Bash: git status");
    this.emitText("Arbeitsverzeichnis ist sauber. Jetzt führe ich die Tests aus.");
    this.emitToolUse("Bash", { command: "npm test" });
    await delay(700);
    // Permission-Loop demonstrieren:
    const requestId = randomUUID();
    this.pending.set(requestId, () => {});
    this.emit({
      ...envelope(),
      type: "permission_request",
      agentId: this.agentId,
      requestId,
      toolName: "Bash",
      input: { command: "git push -u origin feat/demo" },
      kind: "tool",
      decisionReason: "Push auf das Remote ist eine außen-sichtbare Aktion (mads-Invariante 3).",
    });
    this.setStatus("waiting_input", "permission: Bash");
    // wartet auf answerPermission -> mockAfterPermission()
  }

  private async mockAfterPermission(): Promise<void> {
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    this.emitText("Danke. Branch gepusht, ich öffne einen Pull Request.");
    this.emitToolUse("Bash", { command: "gh pr create --fill --base main" });
    await delay(700);
    this.emitText("Fertig. PR #1 erstellt, CI läuft. Ich melde mich beim Integrator.");
    this.costUsd = 0.0142;
    this.numTurns = 5;
    this.emitCost();
    this.emit({
      ...envelope(),
      type: "agent_done",
      agentId: this.agentId,
      subtype: "success",
      sessionId: this.sessionId,
      resultText: "Demo abgeschlossen: Branch gepusht, PR erstellt.",
      totalCostUsd: this.costUsd,
      numTurns: this.numTurns,
      isError: false,
    });
    this.setStatus("done");
  }

  // ----------------------------- Helpers ------------------------------------
  private emitText(text: string): void {
    this.emit({ ...envelope(), type: "agent_event", agentId: this.agentId, event: { kind: "assistant_text", text } });
  }
  private emitToolUse(name: string, input: Record<string, unknown>): void {
    this.emit({ ...envelope(), type: "agent_event", agentId: this.agentId, event: { kind: "tool_use", toolUseId: randomUUID(), name, input } });
  }
  private emitCost(): void {
    this.emit({ ...envelope(), type: "cost_update", agentId: this.agentId, totalCostUsd: this.costUsd, numTurns: this.numTurns });
  }
  private setStatus(status: AgentStatus, currentStep?: string): void {
    this.status = status;
    this.emit({ ...envelope(), type: "status_update", agentId: this.agentId, status, currentStep });
    this.onChange?.();
  }
  private fail(code: string, message: string, recoverable: boolean): void {
    this.emit({ ...envelope(), type: "error", agentId: this.agentId, scope: "agent", code, message, recoverable });
    this.setStatus("error");
  }
  private emit(obj: unknown): void {
    void send(obj);
  }
}
