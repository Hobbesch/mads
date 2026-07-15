# Node-Sidecar-Design — Orchestrierung von N Claude-Code-Agenten

> Recherche für **mads** (Tauri 2 + React/TS, Node-Sidecar mit Claude Agent SDK).
> Stand: 2026-06-19. Bevorzugte Versionen: aktuelle stabile `@anthropic-ai/claude-agent-sdk` (0.3.x-Reihe; siehe Caveats), Node ≥ 20 LTS, Tauri 2.
> Code/Identifier englisch, Erläuterung deutsch.

---

## 0. Kernaussage (TL;DR)

Baue **einen** langlaufenden Node-Sidecar-Prozess, der einen `Map<agentId, AgentSession>`-Pool verwaltet. Jede `AgentSession` startet **einen** `query()`-Aufruf aus dem **Claude Agent SDK (TypeScript)** im **Streaming-Input-Modus** (Prompt = `AsyncIterable<SDKUserMessage>`). Das SDK ist dem direkten `claude`-CLI-Subprocess klar überlegen, weil es die für mads zentralen Features als typisierte In-Process-Callbacks liefert: `canUseTool` (Permission-Interception **inkl.** `AskUserQuestion`), `hooks` (`Notification`/`PreToolUse`/`Stop`), `q.interrupt()`, `q.setPermissionMode()`, `resume`/`forkSession` und `sessionStore` (Persistenz/Reconnect). Das SDK spawnt intern ohnehin den `claude`-Subprocess — du bekommst also dieselbe Isolation, aber ein sauberes API statt selbstgebautes stdin/stdout-JSON-Framing.

Der Sidecar spricht mit dem Tauri-Core über **NDJSON über stdio** (eine JSON-Nachricht pro Zeile, `\n`-terminiert). Das ist robust, einfach zu parsen und sprachneutral (Rust-Seite: zeilenweises Lesen).

---

## 1. Architektur des Sidecars

### 1.1 Prozess-Topologie

```
┌─────────────────────────── Tauri App (macOS) ───────────────────────────┐
│                                                                          │
│   React / TS  (UI: N Agent-Panels, Permission-Dialoge, Cost-HUD)         │
│        │  Tauri events / commands (IPC)                                   │
│   ┌────┴───────── Rust Core (tauri::process::Command / sidecar) ──────┐  │
│   │   schreibt host->sidecar NDJSON auf stdin                          │  │
│   │   liest   sidecar->host NDJSON von stdout (zeilenweise)            │  │
│   └────┬───────────────────────────────────────────────────────────--┘  │
└────────┼─────────────────────────────────────────────────────────────---┘
         │ stdio (NDJSON)
   ┌─────┴──────────────── Node Sidecar (ein Prozess) ──────────────────┐
   │  Orchestrator                                                       │
   │    pool: Map<agentId, AgentSession>                                 │
   │    stdin reader (line-buffered) -> dispatch(HostMessage)            │
   │    stdout writer (serialize SidecarMessage + "\n")                  │
   │                                                                     │
   │  AgentSession #1  ── query() ── spawnt ──> `claude` Subprocess #1   │
   │  AgentSession #2  ── query() ── spawnt ──> `claude` Subprocess #2   │
   │  ...                                                                 │
   │  AgentSession #N  ── query() ── spawnt ──> `claude` Subprocess #N   │
   └─────────────────────────────────────────────────────────────────--┘
```

Jeder Agent läuft also als eigener `claude`-Subprozess (vom SDK gespawnt), aber alle werden **in-process** vom einen Node-Orchestrator koordiniert. Das hält den IPC-Pfad zum Tauri-Core auf genau einen stdio-Kanal.

### 1.2 Die `AgentSession`-Datenstruktur

```typescript
import type { Query, SDKUserMessage, PermissionResult } from "@anthropic-ai/claude-agent-sdk";

type AgentStatus =
  | "starting"
  | "running"          // Agent arbeitet (Tool-Aufrufe etc.)
  | "waiting_input"    // wartet auf User: Permission, AskUserQuestion, idle_prompt
  | "paused"           // via interrupt() angehalten
  | "error"
  | "escalation"       // z.B. gh push rejected, braucht menschliche Entscheidung
  | "done";

interface PendingPermission {
  requestId: string;          // von uns vergeben, fuer answer_permission
  toolName: string;
  input: Record<string, unknown>;
  kind: "tool" | "ask_user_question";
  resolve: (r: PermissionResult) => void;   // schliesst den canUseTool-Callback
  reject: (e: unknown) => void;
}

interface AgentSession {
  agentId: string;
  q: Query;                                  // der laufende query()-Handle
  status: AgentStatus;
  sessionId?: string;                        // aus SDKSystemMessage(init) / result
  worktreePath: string;                      // git worktree dieses Agenten
  branch: string;
  cwd: string;                               // == worktreePath
  inbox: AsyncQueue<SDKUserMessage>;         // fuettert den prompt-AsyncIterable
  pendingPermissions: Map<string, PendingPermission>;
  currentTool?: { name: string; input: unknown; toolUseId: string };
  costUsd: number;
  numTurns: number;
  startedAt: number;
  lastEventAt: number;
  abort: AbortController;
}
```

Der Pool: `const pool = new Map<string, AgentSession>();`

---

## 2. Trade-off: Agent SDK `query()` pro Agent vs. `claude` CLI Subprocess pro Agent

Beide Wege starten letztlich einen `claude`-Subprozess pro Agent (das SDK kapselt genau das). Der Unterschied ist die **Kontroll-Oberfläche**.

| Kriterium | **Agent SDK `query()`** (empfohlen) | **`claude` CLI + `--input/--output-format stream-json`** |
|---|---|---|
| Live-Output | Async-Iterator über `SDKMessage`; `includePartialMessages: true` liefert Token-Deltas (`stream_event`). Typisiert. | NDJSON auf stdout; du musst Zeilen selbst puffern und Events parsen. Event-Schema ist nur teilweise dokumentiert (siehe Caveats). |
| Permission-Interception | **`canUseTool`-Callback** — In-Process, synchron pausiert, kann allow/deny/`updatedInput`/`updatedPermissions` zurückgeben. Fängt auch `AskUserQuestion` ab. | Nur via `--permission-prompt-tool <mcp-tool>`: du musst einen MCP-Server schreiben, der die Approval-Anfrage über einen weiteren Kanal beantwortet. Deutlich umständlicher. |
| Mid-Session Input | `prompt` als `AsyncIterable` oder `q.streamInput(stream)`. | User-Messages als JSON auf stdin schreiben (`--input-format stream-json`). |
| Interrupt / Steuerung | `q.interrupt()`, `q.setPermissionMode()`, `q.setModel()`, `q.setMaxThinkingTokens()`. | Kein sauberes Interrupt-API; SIGINT/Kill grob, Mode-Wechsel mid-session nicht trivial. |
| Hooks | `hooks` als TS-Callbacks: `Notification`, `PreToolUse`, `PostToolUse`, `Stop`, `SessionStart/End`, `PermissionRequest`, `WorktreeCreate/Remove`. | Nur Shell-Command-Hooks über `settings.json`; keine In-Process-Callbacks. |
| Session-Resume | `resume: sessionId` (+ optional `forkSession: true`). | `--resume <sessionId>`. |
| Persistenz / Multi-Host | `sessionStore`-Adapter (S3/Redis/Postgres/eigener), `persistSession`, `sessionId`. | nur lokale JSONL unter `~/.claude/projects/`. |
| cwd / Worktree | `options.cwd`, `options.additionalDirectories`. | `--add-dir` / Prozess-cwd beim Spawn. |
| Cost/Usage | `SDKResultMessage.total_cost_usd`, `.usage`, `.modelUsage`, `.num_turns`. | im `result`-Event enthalten, Felder weniger garantiert dokumentiert. |
| Parallele Agenten | N unabhängige `query()`-Handles im selben Node-Prozess; alles in-process koordinierbar. | N Subprozesse, jeder mit eigenem stdin/stdout, das du multiplexen musst. |

**Fazit:** SDK `query()` gewinnt bei **allen** vier geforderten Achsen (Live-Output, Permission-Interception, Session-Resume, parallele Agenten). Den CLI-Weg nur als Fallback betrachten, falls eine SDK-Version blockiert (siehe Caveats). Die Permission-Interception ist das stärkste Argument: nur über `canUseTool` bekommt mads den synchron pausierenden „Mensch entscheidet"-Punkt ohne MCP-Bastelei.

---

## 3. Protokoll Sidecar ↔ Tauri-Core (NDJSON über stdio)

### 3.1 Framing-Regeln

- Eine JSON-Nachricht **pro Zeile**, mit `\n` terminiert. Keine eingebetteten rohen Newlines (JSON.stringify escaped `\n` ohnehin).
- Rust liest zeilenweise (`BufReader::lines()`), Node liest mit `readline`/Line-Splitter. **Wichtigster Bug-Quell:** Events können über Chunk-Grenzen „straddlen" — immer einen Zeilenpuffer verwenden, nicht pro `data`-Chunk parsen.
- Jede Nachricht trägt `type`, optional `agentId`, und eine `id` für Request/Response-Korrelation.
- **stdout ist nur für Protokoll-NDJSON.** Alle Logs/Debug auf **stderr** (sonst zerstört ein `console.log` den Stream). `options.stderr` des SDK ebenfalls nach stderr leiten.

### 3.2 TypeScript-Interface-Set

```typescript
// ---------- gemeinsame Basis ----------
type Json = Record<string, unknown>;

interface BaseMsg {
  v: 1;                       // Protokoll-Version
  id: string;                 // ULID/UUID, fuer Korrelation
  ts: number;                 // epoch ms
}

// ======================================================================
// HOST -> SIDECAR
// ======================================================================
type HostMessage =
  | StartAgentMsg
  | SendInputMsg
  | AnswerPermissionMsg
  | StopAgentMsg
  | SetPermissionModeMsg
  | InterruptAgentMsg
  | ShutdownMsg;

interface StartAgentMsg extends BaseMsg {
  type: "start_agent";
  agentId: string;
  prompt: string;                       // erste User-Instruktion
  branch: string;                       // git branch fuer den worktree
  baseRef?: string;                     // z.B. "origin/main"
  model?: string;
  permissionMode?: "default" | "acceptEdits" | "plan" | "bypassPermissions" | "dontAsk";
  resumeSessionId?: string;             // Reconnect/Resume
  forkSession?: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
}

interface SendInputMsg extends BaseMsg {
  type: "send_input";
  agentId: string;
  text: string;                         // Follow-up-Nachricht an den laufenden Agenten
}

interface AnswerPermissionMsg extends BaseMsg {
  type: "answer_permission";
  agentId: string;
  requestId: string;                    // == PermissionRequestMsg.requestId
  decision:
    | { behavior: "allow"; updatedInput?: Json; remember?: boolean }
    | { behavior: "deny"; message: string; interrupt?: boolean }
    // Spezialfall AskUserQuestion: Antworten zurueckgeben
    | { behavior: "answer_questions"; answers: Record<string, string | string[]>; response?: string };
}

interface StopAgentMsg extends BaseMsg {
  type: "stop_agent";
  agentId: string;
  removeWorktree?: boolean;             // git worktree remove nach Stop
}

interface SetPermissionModeMsg extends BaseMsg {
  type: "set_permission_mode";
  agentId: string;
  mode: "default" | "acceptEdits" | "plan" | "bypassPermissions" | "dontAsk";
}

interface InterruptAgentMsg extends BaseMsg {
  type: "interrupt_agent";
  agentId: string;
}

interface ShutdownMsg extends BaseMsg {
  type: "shutdown";                     // sauber alle Agenten stoppen
}

// ======================================================================
// SIDECAR -> HOST
// ======================================================================
type SidecarMessage =
  | AgentEventMsg
  | NeedsInputMsg
  | PermissionRequestMsg
  | StatusUpdateMsg
  | CostUpdateMsg
  | AgentDoneMsg
  | SidecarErrorMsg
  | SidecarReadyMsg;

interface SidecarReadyMsg extends BaseMsg {
  type: "sidecar_ready";
  pid: number;
  sdkVersion: string;
  resumableAgents: Array<{ agentId: string; sessionId: string; branch: string }>;
}

// generischer Durchstich von SDK-Messages (assistant text, tool_use, stream_event ...)
interface AgentEventMsg extends BaseMsg {
  type: "agent_event";
  agentId: string;
  event:
    | { kind: "assistant_text"; text: string }
    | { kind: "assistant_delta"; text: string }            // nur bei includePartialMessages
    | { kind: "tool_use"; toolUseId: string; name: string; input: Json }
    | { kind: "tool_result"; toolUseId: string; ok: boolean; summary?: string }
    | { kind: "thinking"; text: string }
    | { kind: "system"; subtype: string; data?: Json };
}

interface NeedsInputMsg extends BaseMsg {
  type: "needs_input";
  agentId: string;
  reason: "idle_prompt" | "notification";
  message?: string;                     // human-readable, z.B. aus Notification-Hook
}

interface PermissionRequestMsg extends BaseMsg {
  type: "permission_request";
  agentId: string;
  requestId: string;
  toolName: string;                     // z.B. "Bash", "Write", "AskUserQuestion"
  input: Json;
  blockedPath?: string;
  decisionReason?: string;
  suggestions?: Json[];                 // PermissionUpdate-Vorschlaege (remember)
  // bei AskUserQuestion: die strukturierten Fragen
  questions?: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string; preview?: string }>;
    multiSelect: boolean;
  }>;
}

interface StatusUpdateMsg extends BaseMsg {
  type: "status_update";
  agentId: string;
  status: AgentStatus;
  currentStep?: string;                 // z.B. "Bash: npm test"
  currentTool?: string;
}

interface CostUpdateMsg extends BaseMsg {
  type: "cost_update";
  agentId: string;
  totalCostUsd: number;
  numTurns: number;
  inputTokens?: number;
  outputTokens?: number;
}

interface AgentDoneMsg extends BaseMsg {
  type: "agent_done";
  agentId: string;
  subtype: "success" | "error_max_turns" | "error_during_execution" | "error_max_budget_usd";
  sessionId: string;
  resultText?: string;
  totalCostUsd: number;
  numTurns: number;
  isError: boolean;
}

interface SidecarErrorMsg extends BaseMsg {
  type: "error";
  agentId?: string;
  scope: "agent" | "sidecar";
  code: string;                         // z.B. "git_push_rejected", "spawn_failed"
  message: string;
  recoverable: boolean;
}
```

---

## 4. Erkennung des Agenten-Zustands (a–e)

Das ist der Kern für ein gutes mads-UI. Die Signale kommen aus **drei** Quellen: dem Message-Stream (`SDKMessage`), den **Hooks** und dem **`canUseTool`-Callback**.

### (a) Wartet auf User-Input

Drei verschiedene Auslöser — alle wichtig:

1. **Tool-Permission** und **`AskUserQuestion`** → kommen über **`canUseTool`**. Der Callback pausiert die Ausführung, bis er resolved. mads: `status = "waiting_input"`, `permission_request` senden, im `pendingPermissions`-Map die `resolve`-Funktion halten.
   - Unterscheidung: `toolName === "AskUserQuestion"` ⇒ strukturierte Multiple-Choice-Fragen (Feld `questions`), sonst normale Tool-Approval.
2. **`Notification`-Hook** signalisiert idle/permission-Status. Subtypen lt. Doku:
   - `permission_prompt` — Claude braucht Permission
   - `idle_prompt` — Claude wartet auf Input (kein Tool, sondern „dein Zug")
   - `auth_success`, `elicitation_dialog`/`elicitation_complete`/`elicitation_response`
   - Jede Notification hat ein `message`-Feld (human-readable) → ideal für „Agent X wartet auf dich"-Badge und Push.
3. **`onElicitation`-Callback** (Options-Feld) für MCP-Elicitation-Flows (strukturierte Eingaben von MCP-Servern).

> Wichtiger Hebel: Der `canUseTool`-Callback **darf beliebig lange pending bleiben** — die Ausführung bleibt pausiert, bis er zurückkehrt; das SDK bricht nur ab, wenn die Query gecancelt wird. Für mads heißt das: Du kannst den Menschen in Ruhe entscheiden lassen. Wenn der Mensch evtl. *sehr* lange braucht (App-Neustart), nutze die **`defer`**-Hook-Decision (siehe §7).

### (b) Aktueller Schritt / Tool

- Aus `SDKAssistantMessage.message.content`: Blöcke vom Typ `tool_use` ⇒ `currentTool = { name, input, toolUseId }`, `status_update` mit `currentStep` senden (z.B. `"Bash: npm test"`).
- Optional `PreToolUse`-Hook für eine garantierte „about to run X"-Markierung vor Ausführung.

### (c) Fortschritt

Es gibt keinen numerischen Prozent-Wert; approximiere aus:
- `num_turns` (steigt pro Agent-Turn; auch live über Zwischen-Results),
- Anzahl `tool_use`/`tool_result`-Paare,
- `option.agentProgressSummaries: true` (liefert Progress-Zusammenfassungen),
- Plan-Mode: Plan-Schritte abhaken.

### (d) Fehler / Eskalation (z.B. `gh push rejected`)

Es gibt **kein** dediziertes „push rejected"-Event. Solche Fehler erscheinen als **`tool_result` eines `Bash`/`gh`-Aufrufs mit Fehlertext**. Strategie:
- `PostToolUse`/`PostToolUseFailure`-Hook auf `Bash` und MCP-`gh`-Tools registrieren; im Output nach Mustern wie `! [rejected]`, `non-fast-forward`, `Updates were rejected`, `Permission denied`, `merge conflict` suchen ⇒ `SidecarErrorMsg{ code: "git_push_rejected", recoverable: true }` + `status = "escalation"`.
- Globale Signale: `SDKResultMessage.subtype` `error_during_execution`/`error_max_turns`/`error_max_budget_usd`; `system/api_retry`-Events (rate_limit, server_error, auth, billing) als Warn-Status.
- `permission_denials` im Result-Message für nachträgliche Auswertung.

### (e) Fertig

- **`SDKResultMessage`** (`type: "result"`) ist das definitive End-Signal eines Turn-Laufs ⇒ `agent_done` mit `subtype`, `total_cost_usd`, `num_turns`, `session_id`.
- Im Streaming-Input-Modus bedeutet ein `result` nur das Ende **dieses** Auftrags; die Session bleibt offen für weitere `send_input`. Erst beim Schließen des Input-Iterators / `q.close()` ist der Agent endgültig beendet.
- Zusätzlich `Stop`-Hook für „Agent ist idle geworden".

---

## 5. Backpressure & Performance bei vielen Output-Streams

Bei N parallelen Agenten mit `includePartialMessages: true` entstehen sehr viele kleine Events. Maßnahmen:

1. **Token-Deltas drosseln/koaleszieren.** `assistant_delta`-Events pro Agent in einem ~30–60 ms-Fenster zusammenfassen, bevor sie als NDJSON gesendet werden. Reduziert IPC-Zeilen drastisch. Alternativ Partial-Messages nur für den **fokussierten** Agenten aktivieren und für Hintergrund-Agenten `includePartialMessages: false`.
2. **stdout-Backpressure respektieren.** `process.stdout.write()` gibt `false` zurück, wenn der Kernel-Buffer voll ist ⇒ auf das `"drain"`-Event warten, bevor weitergeschrieben wird. Sonst wächst der Node-Heap unbegrenzt, wenn der Rust-Leser langsamer ist.
   ```typescript
   function writeLine(obj: SidecarMessage): Promise<void> {
     const line = JSON.stringify(obj) + "\n";
     return new Promise((resolve) => {
       const ok = process.stdout.write(line);
       if (ok) resolve();
       else process.stdout.once("drain", resolve);
     });
   }
   ```
3. **Pro-Agent serielle Sende-Queue.** Jede Session schreibt über eine eigene async-Queue, damit `await writeLine(...)` die Reihenfolge wahrt und Backpressure pro Agent greift (kein Interleaving halber Zeilen).
4. **Bounded inbox.** Die `inbox`-Queue (User-Inputs → Agent) sollte begrenzt sein; bei Überlauf neue Inputs ablehnen statt unbegrenzt puffern.
5. **Begrenzung paralleler Agenten.** Jeder Agent = eigener `claude`-Subprozess (RAM/CPU). Concurrency-Limit (z.B. 4–8 aktive) + Warteschlange; UI zeigt „queued".
6. **Großvolumige Tool-Outputs nicht 1:1 weiterleiten.** `tool_result`-Inhalte (Diffs, Test-Logs) kürzen/zusammenfassen für den Live-Stream; Volltext auf Abruf (Lazy) aus dem Transcript.
7. **Rust-Seite ebenfalls line-buffered lesen** und Events asynchron an die UI emitten, damit der Pipe nicht blockiert.

---

## 6. Worktree-Management aus dem Sidecar

Jeder Agent bekommt einen isolierten `git worktree` + eigene Branch. Das ist die saubere Isolation für „N Agenten parallel ohne sich gegenseitig zu stören".

### 6.1 Lifecycle (per Agent)

```typescript
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

async function createWorktree(repoRoot: string, agentId: string, branch: string, baseRef = "origin/main") {
  const wtPath = `${repoRoot}/.mads/worktrees/${agentId}`;
  // neuer Branch + neues Verzeichnis in einem Schritt:
  await exec("git", ["-C", repoRoot, "worktree", "add", "-b", branch, wtPath, baseRef]);
  return wtPath;
}

async function removeWorktree(repoRoot: string, wtPath: string) {
  // --force falls uncommittete Aenderungen; danach Branch optional loeschen
  await exec("git", ["-C", repoRoot, "worktree", "remove", "--force", wtPath]);
}
```

- Worktrees zentral unter z.B. `<repo>/.mads/worktrees/<agentId>` ablegen (in `.gitignore` aufnehmen).
- `git worktree list --porcelain` beim Start parsen, um verwaiste Worktrees nach Crash zu finden und ggf. zu recyceln/aufzuräumen.
- `git worktree prune` periodisch für Leichen.

### 6.2 Arbeitsverzeichnis an die Session binden

```typescript
const q = query({
  prompt: inboxAsIterable(session.inbox),
  options: {
    cwd: session.worktreePath,            // <- Agent arbeitet im eigenen Worktree
    additionalDirectories: [repoRoot],    // optional Lesezugriff auf Repo-Root/Shared
    // ...
  },
});
```

- Beim CLI-Weg analog: Prozess-`cwd` = Worktree, zusätzliche Pfade via `--add-dir`.
- Für Node-Projekte: jeder Worktree hat eigene `node_modules`/Build-Artefakte. Mit **pnpm** + globalem Store sind die `node_modules` nur Symlinks ⇒ schnelles, platzsparendes Hinzufügen neuer Agenten.
- Die SDK-Hooks **`WorktreeCreate`/`WorktreeRemove`** existieren (TS-only) und können für Tracking genutzt werden — aber das **explizite** `git worktree add/remove` aus dem Sidecar gibt dir die volle Kontrolle (Branch-Namen, Base-Ref, Cleanup-Policy). Empfehlung: Worktrees selbst managen, Hooks nur zum Beobachten.

---

## 7. Robustheit: Crash-Recovery, Persistenz, Reconnect

### 7.1 Session-IDs persistieren

- Die `session_id` kommt zuerst in `SDKSystemMessage` (`subtype: "init"`) und in jedem `SDKResultMessage`. **Sofort auf Platte speichern**, sobald bekannt.
- Empfohlene On-Disk-Registry (z.B. `<repo>/.mads/agents.json`), atomar geschrieben (write-temp + rename):
  ```json
  {
    "agents": {
      "agent-7": {
        "sessionId": "f3c1...",
        "branch": "feat/login",
        "worktreePath": "/…/.mads/worktrees/agent-7",
        "status": "waiting_input",
        "lastPrompt": "implement login form",
        "updatedAt": 1718800000000
      }
    }
  }
  ```

### 7.2 Reconnect nach App-Neustart

1. Sidecar startet, liest `agents.json`, sendet `sidecar_ready` mit `resumableAgents`.
2. Tauri-Core/UI bietet Resume an; pro Agent `start_agent` mit `resumeSessionId` (und ggf. `forkSession: true`, wenn man die alte Historie nicht überschreiben will).
3. `query({ options: { resume: sessionId, cwd: worktreePath, sessionStore } })` lädt die volle Konversation und macht weiter.

### 7.3 `sessionStore` für Durability

- `SessionStore` = Adapter mit Pflicht-Methoden `append(key, entries)` und `load(key)` plus optional `listSessions`/`delete`/`listSubkeys`.
- Architektur ist **Dual-Write**: der `claude`-Subprozess schreibt immer zuerst lokal nach `~/.claude/projects/`, das SDK spiegelt dann in den Store. Mirror-Fehler sind best-effort (`{ type:"system", subtype:"mirror_error" }`) und brechen die Query nicht ab.
- Für mads-Desktop reicht zunächst die lokale JSONL-Persistenz (Default) plus die eigene `agents.json`-Registry. `sessionStore` (S3/Redis/Postgres-Referenzadapter im SDK-Repo) erst, wenn Multi-Host/Cloud relevant wird.
- **Caveat:** `sessionStore` ist **nicht** mit `persistSession: false` und nicht mit `enableFileCheckpointing` kombinierbar (SDK wirft).

### 7.4 `defer` für sehr lange Wartezeiten

Wenn ein Agent auf eine Permission wartet und der Prozess währenddessen nicht laufen soll (App-Quit), kann ein `PreToolUse`-Hook `permissionDecision: "defer"` zurückgeben. Das **beendet die Query**, sodass der Prozess sauber exiten kann; später aus der persistierten Session **resumen**. Priorität der Decisions: `deny` > `defer` > `ask` > `allow`.

### 7.5 Crash-Erkennung & Aufräumen

- Subprozess-Exit/Spawn-Fehler ⇒ `SidecarErrorMsg{ scope:"agent", code:"spawn_failed", recoverable:true }`; Auto-Restart mit Backoff (max. Retries), dann Eskalation.
- Sidecar-Crash ⇒ Tauri-Core erkennt EOF auf stdout; Supervisor-Strategie: Sidecar neu starten, `agents.json` lesen, Agenten anbieten (nicht automatisch alle neu starten — Kostenrisiko).
- Beim Stop: `q.close()`/`q.interrupt()` aufrufen, dann optional `git worktree remove`.

---

## 8. Minimales lauffähiges Codebeispiel

> **Ein** Agent, gestartet vom Sidecar, Events als NDJSON nach stdout. Bewusst reduziert auf das, was am Prototyp **zuerst** zählt: Streaming-Input-Loop, Live-Events, `canUseTool` → `permission_request`, `answer_permission`, `cost_update`, `agent_done`, Backpressure-sicheres Schreiben. (Logs gehen auf stderr.)

```typescript
// sidecar.ts  —  run:  node --experimental-strip-types sidecar.ts   (oder via tsx/esbuild)
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  Query, SDKUserMessage, SDKMessage, PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import readline from "node:readline";
import { randomUUID } from "node:crypto";

// ---------- NDJSON Output (backpressure-aware, serialisiert) ----------
let writeChain: Promise<void> = Promise.resolve();
function send(obj: unknown): Promise<void> {
  writeChain = writeChain.then(
    () =>
      new Promise<void>((resolve) => {
        const ok = process.stdout.write(JSON.stringify(obj) + "\n");
        ok ? resolve() : process.stdout.once("drain", resolve);
      }),
  );
  return writeChain;
}
const log = (...a: unknown[]) => process.stderr.write(a.join(" ") + "\n");

// ---------- einfache async Queue als prompt-AsyncIterable ----------
class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: ((v: IteratorResult<T>) => void)[] = [];
  private done = false;
  push(v: T) {
    const w = this.waiters.shift();
    if (w) w({ value: v, done: false });
    else this.items.push(v);
  }
  close() {
    this.done = true;
    this.waiters.splice(0).forEach((w) => w({ value: undefined as any, done: true }));
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () =>
        new Promise<IteratorResult<T>>((resolve) => {
          if (this.items.length) resolve({ value: this.items.shift()!, done: false });
          else if (this.done) resolve({ value: undefined as any, done: true });
          else this.waiters.push(resolve);
        }),
    };
  }
}

// ---------- eine Session ----------
interface Session {
  agentId: string;
  q: Query;
  inbox: AsyncQueue<SDKUserMessage>;
  pending: Map<string, (r: PermissionResult) => void>;
  sessionId?: string;
}
const pool = new Map<string, Session>();

function userMsg(text: string): SDKUserMessage {
  return {
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "text", text }] },
  } as SDKUserMessage;
}

async function startAgent(agentId: string, prompt: string, cwd: string) {
  const inbox = new AsyncQueue<SDKUserMessage>();
  const pending = new Map<string, (r: PermissionResult) => void>();
  inbox.push(userMsg(prompt));

  const q = query({
    prompt: inbox,
    options: {
      cwd,
      includePartialMessages: false,             // erst spaeter aktivieren (Backpressure)
      permissionMode: "default",
      stderr: (d) => log(`[claude ${agentId}]`, d),
      // ---- Permission-Interception (auch AskUserQuestion) ----
      canUseTool: (toolName, input, _opts): Promise<PermissionResult> =>
        new Promise((resolve) => {
          const requestId = randomUUID();
          pending.set(requestId, resolve);
          send({
            v: 1, id: randomUUID(), ts: Date.now(),
            type: "permission_request", agentId, requestId, toolName, input,
            questions: toolName === "AskUserQuestion" ? (input as any).questions : undefined,
          });
          send(statusUpdate(agentId, "waiting_input", `permission: ${toolName}`));
        }),
      // ---- waiting/idle erkennen ----
      hooks: {
        Notification: [{
          hooks: [async (inp: any) => {
            send({ v: 1, id: randomUUID(), ts: Date.now(),
              type: "needs_input", agentId,
              reason: inp?.message?.includes("waiting") ? "idle_prompt" : "notification",
              message: inp?.message });
            return {};
          }],
        }],
      },
    },
  });

  const s: Session = { agentId, q, inbox, pending };
  pool.set(agentId, s);
  send(statusUpdate(agentId, "running"));
  consume(s).catch((e) => send({
    v: 1, id: randomUUID(), ts: Date.now(),
    type: "error", agentId, scope: "agent", code: "consume_failed",
    message: String(e), recoverable: false,
  }));
}

function statusUpdate(agentId: string, status: string, currentStep?: string) {
  return { v: 1, id: randomUUID(), ts: Date.now(), type: "status_update", agentId, status, currentStep };
}

async function consume(s: Session) {
  for await (const m of s.q as AsyncIterable<SDKMessage>) {
    switch (m.type) {
      case "system":
        if ((m as any).subtype === "init") s.sessionId = m.session_id;
        break;
      case "assistant": {
        for (const block of (m as any).message.content as any[]) {
          if (block.type === "text")
            await send({ v: 1, id: randomUUID(), ts: Date.now(), type: "agent_event",
              agentId: s.agentId, event: { kind: "assistant_text", text: block.text } });
          else if (block.type === "tool_use") {
            await send({ v: 1, id: randomUUID(), ts: Date.now(), type: "agent_event",
              agentId: s.agentId, event: { kind: "tool_use", toolUseId: block.id, name: block.name, input: block.input } });
            await send(statusUpdate(s.agentId, "running", `${block.name}`));
          }
        }
        break;
      }
      case "result": {
        await send({ v: 1, id: randomUUID(), ts: Date.now(), type: "cost_update",
          agentId: s.agentId, totalCostUsd: (m as any).total_cost_usd, numTurns: (m as any).num_turns });
        await send({ v: 1, id: randomUUID(), ts: Date.now(), type: "agent_done",
          agentId: s.agentId, subtype: (m as any).subtype, sessionId: m.session_id,
          resultText: (m as any).result, totalCostUsd: (m as any).total_cost_usd,
          numTurns: (m as any).num_turns, isError: (m as any).is_error });
        // Im Streaming-Input-Modus bleibt die Query offen fuer weitere send_input.
        break;
      }
    }
  }
}

// ---------- HOST -> SIDECAR ----------
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg: any;
  try { msg = JSON.parse(line); } catch { return log("bad json:", line); }
  const s = msg.agentId ? pool.get(msg.agentId) : undefined;

  switch (msg.type) {
    case "start_agent":
      await startAgent(msg.agentId, msg.prompt, msg.cwd ?? process.cwd());
      break;
    case "send_input":
      s?.inbox.push(userMsg(msg.text));
      break;
    case "answer_permission": {
      const resolve = s?.pending.get(msg.requestId);
      if (resolve) {
        s!.pending.delete(msg.requestId);
        const d = msg.decision;
        if (d.behavior === "allow") resolve({ behavior: "allow", updatedInput: d.updatedInput });
        else if (d.behavior === "answer_questions")
          resolve({ behavior: "allow", updatedInput: { questions: (msg.questions ?? []), answers: d.answers, response: d.response } });
        else resolve({ behavior: "deny", message: d.message, interrupt: d.interrupt });
        await send(statusUpdate(msg.agentId, "running"));
      }
      break;
    }
    case "interrupt_agent": await s?.q.interrupt(); break;
    case "set_permission_mode": await s?.q.setPermissionMode(msg.mode); break;
    case "stop_agent": s?.inbox.close(); s?.q.close(); pool.delete(msg.agentId); break;
    case "shutdown":
      for (const a of pool.values()) { a.inbox.close(); a.q.close(); }
      process.exit(0);
  }
});

send({ v: 1, id: randomUUID(), ts: Date.now(), type: "sidecar_ready",
  pid: process.pid, sdkVersion: "unknown", resumableAgents: [] });
log("sidecar up");
```

**Was am Prototyp zuerst gebaut werden sollte (Priorisierung):**
1. **stdio-NDJSON-Transport** mit Line-Buffering + backpressure-safe `send()` (oben). Ohne das ist alles andere instabil.
2. **Ein Agent** mit `query()` im Streaming-Input-Modus: `start_agent` → Live-`agent_event` → `result`/`agent_done`.
3. **`canUseTool` → `permission_request` → `answer_permission`-Roundtrip.** Das ist das Herzstück des „Mensch + viele Agenten"-Modells und sollte sehr früh stehen.
4. **`Notification`-Hook** für „wartet auf dich" (`idle_prompt`/`permission_prompt`).
5. **Worktree-Anlage** (`git worktree add -b`) + `cwd`-Bindung.
6. **Session-ID-Persistenz** (`agents.json`) + `resume`.
7. Erst danach: Partial-Token-Streaming (mit Drosselung), Eskalations-Heuristiken (`gh push rejected`), `sessionStore`, Auto-Restart/Crash-Recovery, Concurrency-Limit.

---

## 9. Wichtigste Caveats / offene Punkte

1. **SDK-Versionspflicht vor Implementierung.** Exakte Feldnamen/Verfügbarkeiten (`sessionStore`, `WorktreeCreate/Remove`-Hooks, `auto`-PermissionMode, `defer`, `onElicitation`, `Notification`-Subtypen) variieren zwischen 0.3.x-Releases. **UNVERIFIZIERT:** konkrete „latest"-Versionsnummer (Releases nennen 0.3.176/0.3.177, npm-Seite war zum Recherchezeitpunkt nicht eindeutig). Vor dem Coden: `npm view @anthropic-ai/claude-agent-sdk version` und die TS-Typdefinitionen (`node_modules/@anthropic-ai/claude-agent-sdk/*.d.ts`) als „Single Source of Truth" gegenprüfen.
2. **`AskUserQuestion` nicht in Subagents.** Laut Doku ist `AskUserQuestion` in via `Agent`-Tool gespawnten Subagents derzeit **nicht** verfügbar; ebenso erben Subagents `bypassPermissions`/`acceptEdits`/`auto` zwingend vom Parent. Für mads (Main-Integrator + Sub-Agents) heißt das: Sub-Agent-Rückfragen müssen anders gelöst werden (eigene Top-Level-`query()` pro Agent statt Agent-Tool-Subagents — was die hier vorgeschlagene Pool-Architektur ohnehin tut). Das Pool-Modell (jeder „Sub-Agent 1..N" ist eine **eigene** `query()`-Session, kein SDK-internes Subagent) umgeht das Limit — bewusst so designen.
3. **`gh push rejected` & Co. haben kein eigenes Event.** Solche Eskalationen sind nur über **Output-Pattern-Matching** auf `Bash`/`gh`-`tool_result` (via `PostToolUse`/`PostToolUseFailure`-Hook) erkennbar. Das ist heuristisch und brüchig (Lokalisierung, geänderte gh-Meldungen). Muster in eine zentrale, leicht erweiterbare Tabelle auslegen; zusätzlich `permission_denials` und `result.subtype` auswerten. Außerdem offen: **Backpressure-Tuning** (Delta-Koaleszenz-Fenster, Concurrency-Limit) und **Worktree-Cleanup-Policy** nach Crash müssen empirisch kalibriert werden.

---

## 10. Quellen

- Claude Agent SDK — TypeScript Reference: https://code.claude.com/docs/en/agent-sdk/typescript (Redirect-Kette von docs.claude.com / platform.claude.com; abgerufen 2026-06-19)
- Handle approvals and user input (canUseTool, AskUserQuestion, defer, Notification): https://code.claude.com/docs/en/agent-sdk/user-input (2026-06-19)
- Configure permissions (Evaluierungsreihenfolge, PermissionMode, PermissionResult): https://code.claude.com/docs/en/agent-sdk/permissions (2026-06-19)
- Control agent behavior with hooks (Hook-Liste, Notification-Subtypen, defer, WorktreeCreate/Remove, async outputs): https://code.claude.com/docs/en/agent-sdk/hooks (2026-06-19)
- Persist sessions to external storage (SessionStore, persistSession, dual-write, forkSession): https://code.claude.com/docs/en/agent-sdk/session-storage (2026-06-19)
- Context7 — Claude Agent SDK docs (SDKMessage/SDKResultMessage/SDKSystemMessage/SDKPartialAssistantMessage, Query-Interface, Options): /nothflare/claude-agent-sdk-docs (2026-06-19)
- claude CLI stream-json Format (NDJSON-Framing, line-buffering, system/api_retry): https://backgroundclaude.com/blog/stream-json (2026-06-19)
- Claude Code CLI stream-json / input-format Issues (Doku-Lücken): https://github.com/anthropics/claude-code/issues/24594, https://github.com/anthropics/claude-code/issues/24596 (2026-06-19)
- Git worktrees für parallele AI-Agenten (Isolation, pnpm-Store): https://www.mindstudio.ai/blog/git-worktrees-parallel-ai-coding-agents , https://pnpm.io/next/git-worktrees (2026-06-19)
- npm @anthropic-ai/claude-agent-sdk / Releases (Versionsstand, UNVERIFIZIERT): https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk , https://github.com/anthropics/claude-agent-sdk-typescript/releases (2026-06-19)
