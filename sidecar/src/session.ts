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
import { classifyToolCall } from "../../shared/safe-command.js";
import type {
  StartAgentMsg,
  PermissionDecision,
  AgentStatus,
  ImageInput,
} from "../../shared/protocol.js";

// Loses SDK-Typing: die exakte API entwickelt sich (0.3.x). Wir casten defensiv.
type PermissionResult =
  | { behavior: "allow"; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] }
  | { behavior: "deny"; message: string; interrupt?: boolean };

interface PendingPermission {
  resolve: (r: PermissionResult) => void;
  suggestions?: unknown[]; // Regel-Vorschläge von Claude Code (für „Immer erlauben")
}

interface SdkUserMessage {
  type: "user";
  message: { role: "user"; content: string | unknown[] };
  parent_tool_use_id: null;
  session_id?: string;
}

interface QueryHandle extends AsyncIterable<unknown> {
  interrupt?: () => Promise<void>;
  setPermissionMode?: (mode: string) => Promise<void>;
  close?: () => void;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: unknown }).text ?? "") : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}
function cap(text: string, max = 4000): string {
  return text.length > max ? `${text.slice(0, max)}\n… [${text.length - max} Zeichen gekürzt]` : text;
}

/** SDKAssistantMessageError → klare deutsche Meldung + ob es sich lohnt, erneut zu versuchen. */
function apiErrorInfo(err: string): { message: string; recoverable: boolean } {
  switch (err) {
    case "rate_limit":
      return { message: "Rate-Limit / Nutzungskontingent erreicht (Abo). Kurz warten und erneut senden.", recoverable: true };
    case "overloaded":
      return { message: "Anthropic-Server überlastet (529). Kurz warten und erneut versuchen.", recoverable: true };
    case "server_error":
      return { message: "Server-Fehler bei Anthropic. Erneut versuchen.", recoverable: true };
    case "max_output_tokens":
      return { message: "Antwort abgeschnitten (max. Output-Tokens erreicht).", recoverable: true };
    case "billing_error":
      return { message: "Abrechnungs-/Kontingentproblem mit dem Anthropic-Konto.", recoverable: false };
    case "authentication_failed":
    case "oauth_org_not_allowed":
      return { message: "Authentifizierung fehlgeschlagen — Claude-Login/Token prüfen.", recoverable: false };
    case "model_not_found":
      return { message: "Angefordertes Modell nicht verfügbar.", recoverable: false };
    case "invalid_request":
      return { message: "Ungültige Anfrage ans Modell.", recoverable: false };
    default:
      return { message: `API-Fehler: ${err}`, recoverable: true };
  }
}

function userMsg(text: string, images?: ImageInput[]): SdkUserMessage {
  if (images && images.length > 0) {
    const content: unknown[] = [{ type: "text", text }];
    for (const im of images) {
      content.push({ type: "image", source: { type: "base64", media_type: im.mediaType, data: im.dataBase64 } });
    }
    return { type: "user", message: { role: "user", content }, parent_tool_use_id: null };
  }
  return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
}

export class AgentSession {
  readonly agentId: string;
  status: AgentStatus = "starting";
  sessionId?: string;
  costUsd = 0;
  numTurns = 0;
  // Token-Verbrauch (kumuliert über alle Assistant-Messages) — die für Abo-Nutzer
  // sinnvolle Metrik (der $-Wert des SDK ist auf der Subscription nicht aussagekräftig).
  inputTokens = 0;
  outputTokens = 0;
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
  // Aktueller Permission-Modus + Arbeitsverzeichnis — für die mads-Auto-Freigabe.
  private permissionMode?: string;
  private cwd?: string;

  private readonly inbox = new AsyncQueue<SdkUserMessage>();
  private readonly pending = new Map<string, PendingPermission>();
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
    this.permissionMode = msg.permissionMode;
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

    this.cwd = cwd;

    try {
      const sdk = (await import("@anthropic-ai/claude-agent-sdk")) as {
        query: (args: { prompt: AsyncIterable<SdkUserMessage>; options: Record<string, unknown> }) => QueryHandle;
      };

      this.q = sdk.query({
        prompt: this.inbox,
        options: {
          cwd,
          model: msg.model,
          // Standard-Claude-Code-Verhalten + Sprach-Vorgabe: mit dem Menschen auf Deutsch
          // kommunizieren (Fragen/Optionen/Erklärungen); Code/Commits/PRs nach CLAUDE.md.
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append:
              "Kommuniziere mit dem Menschen standardmäßig auf DEUTSCH — alle Erklärungen, " +
              "Zusammenfassungen und besonders AskUserQuestion-Fragen samt Optionen (Label + " +
              "Beschreibung) auf Deutsch. Code, Bezeichner, Commit-Messages und PR-Titel nach " +
              "Projektkonvention (CLAUDE.md), aber die Konversation mit dem Nutzer auf Deutsch.",
          },
          // "auto" wird mads-seitig behandelt (Auto-Freigabe im canUseTool); dem SDK
          // geben wir "default", damit jeder nicht-lesende Aufruf über canUseTool läuft.
          permissionMode: msg.permissionMode === "auto" ? "default" : (msg.permissionMode ?? "default"),
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
    // Auto-Modus: harmlose (lesende + datei-ändernde) Aktionen ohne Rückfrage erlauben;
    // außen-sichtbare/destruktive Aktionen kommen mit klarem Grund zur Bestätigung.
    if (this.permissionMode === "auto" && toolName !== "AskUserQuestion") {
      const verdict = classifyToolCall(toolName, input, { cwd: this.cwd });
      if (verdict.decision === "allow") {
        return Promise.resolve({ behavior: "allow" });
      }
      return this.promptPermission(toolName, input, opts, verdict.reason);
    }
    return this.promptPermission(toolName, input, opts);
  }

  private promptPermission(
    toolName: string,
    input: Record<string, unknown>,
    opts: Record<string, unknown>,
    smartReason?: string,
  ): Promise<PermissionResult> {
    return new Promise<PermissionResult>((resolve) => {
      const requestId = randomUUID();
      this.pending.set(requestId, { resolve, suggestions: opts.suggestions as unknown[] | undefined });
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
        decisionReason: smartReason ?? (opts.decisionReason as string | undefined),
        suggestions: opts.suggestions as unknown[] | undefined,
      });
      this.setStatus("waiting_input", `permission: ${toolName}`);
    });
  }

  answerPermission(requestId: string, decision: PermissionDecision): void {
    const entry = this.pending.get(requestId);
    if (!entry) {
      log(`[${this.agentId}] unknown requestId`, requestId);
      return;
    }
    this.pending.delete(requestId);
    const { resolve, suggestions } = entry;
    if (decision.behavior === "allow") {
      resolve({
        behavior: "allow",
        updatedInput: decision.updatedInput,
        updatedPermissions: decision.remember ? suggestions : undefined,
      });
    } else if (decision.behavior === "answer_questions") {
      // AskUserQuestion lässt sich headless nicht „ausführen" (allow → SDK startet das
      // interaktive Tool → Harness-Fehler). Die Auswahl daher als Ergebnis zurückgeben:
      // deny mit der Antwort als Nachricht, sodass das Modell mit der Wahl weiterarbeitet.
      const picks = Object.entries(decision.answers ?? {}).map(([q, a]) => `• ${q} → ${a}`);
      let message: string;
      if (picks.length > 0) {
        message = `Antwort des Nutzers:\n${picks.join("\n")}`;
        if (decision.response && decision.response.trim()) message += `\n• Ergänzung: ${decision.response.trim()}`;
        message += `\n\nFahre mit dieser Wahl fort und rufe AskUserQuestion dafür nicht erneut auf.`;
      } else {
        // Freitext-Anweisung ohne konkrete Auswahl (z.B. Parallel-Streams-Einschätzung).
        message = (decision.response && decision.response.trim()) || "(keine Auswahl getroffen)";
      }
      resolve({ behavior: "deny", message });
    } else {
      resolve({ behavior: "deny", message: decision.message, interrupt: decision.interrupt });
    }
    this.setStatus("running");
    if (this.mock) void this.mockAfterPermission();
  }

  sendInput(text: string, images?: ImageInput[]): void {
    this.inbox.push(userMsg(text, images));
    this.setStatus("running");
    if (this.mock) void this.runMock(text);
  }

  async interrupt(): Promise<void> {
    await this.q?.interrupt?.();
    this.setStatus("paused");
  }

  async setMode(mode: string): Promise<void> {
    this.permissionMode = mode;
    // "auto" handhabt mads selbst → dem SDK "default" geben (siehe start()).
    await this.q?.setPermissionMode?.(mode === "auto" ? "default" : mode);
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
              } else if (block.type === "thinking") {
                const t = String(block.thinking ?? block.text ?? "");
                if (t) this.emit({ ...envelope(), type: "agent_event", agentId: this.agentId, event: { kind: "thinking", text: t } });
              } else if (block.type === "tool_use") {
                this.emit({ ...envelope(), type: "agent_event", agentId: this.agentId, event: { kind: "tool_use", toolUseId: String(block.id), name: String(block.name), input: (block.input ?? {}) as Record<string, unknown> } });
                this.setStatus("running", String(block.name));
              }
            }
            // API-Fehler dieser Antwort (rate_limit, overloaded, …) klar melden statt
            // als generisches „Fehler".
            if (typeof m.error === "string" && m.error) {
              const info = apiErrorInfo(m.error);
              this.emit({
                ...envelope(),
                type: "error",
                agentId: this.agentId,
                scope: "agent",
                code: m.error,
                message: info.message,
                recoverable: info.recoverable,
              });
            }
            // Token-Verbrauch dieser Assistant-Antwort kumulieren und live melden —
            // so steigt die Token-Anzeige im UI sichtbar während des Laufs.
            const usage = (m.message as { usage?: Record<string, number> })?.usage;
            if (usage) {
              this.inputTokens += Number(usage.input_tokens ?? 0);
              this.outputTokens += Number(usage.output_tokens ?? 0);
              this.emitCost();
            }
            break;
          }
          case "user": {
            const content = (m.message as { content?: unknown })?.content;
            if (Array.isArray(content)) {
              for (const block of content as Array<Record<string, unknown>>) {
                if (block.type === "tool_result") {
                  this.emit({
                    ...envelope(),
                    type: "agent_event",
                    agentId: this.agentId,
                    event: {
                      kind: "tool_result",
                      toolUseId: String(block.tool_use_id),
                      ok: !block.is_error,
                      output: cap(toolResultText(block.content)),
                    },
                  });
                }
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
    this.pending.set(requestId, { resolve: () => {} });
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
    if (this.mock) {
      // grobe Schätzung, damit die Token-Anzeige im Mock sichtbar mitläuft
      this.inputTokens += 1200 + Math.round(text.length / 4);
      this.outputTokens += Math.round(text.length / 4);
      this.emitCost();
    }
  }
  private emitToolUse(name: string, input: Record<string, unknown>): void {
    const toolUseId = randomUUID();
    this.emit({ ...envelope(), type: "agent_event", agentId: this.agentId, event: { kind: "tool_use", toolUseId, name, input } });
    this.emit({ ...envelope(), type: "agent_event", agentId: this.agentId, event: { kind: "tool_result", toolUseId, ok: true, output: "(mock) ok" } });
  }
  private emitCost(): void {
    this.emit({
      ...envelope(),
      type: "cost_update",
      agentId: this.agentId,
      totalCostUsd: this.costUsd,
      numTurns: this.numTurns,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
    });
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
