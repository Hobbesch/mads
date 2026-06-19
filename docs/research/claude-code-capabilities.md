# Claude Code & Claude Agent SDK — Fähigkeiten (Stand 2026-06-19)

> Recherche-Befund für das Projekt **mads** (Tauri 2 + React/TS, Node-Sidecar mit dem offiziellen Claude Agent SDK).
> Ziel: verstehen, wie mads viele parallele Claude-Code-Agenten steuert (Main/Integrator + Sub-Agents 1..N, je eigener Branch/Worktree).
> Code/Identifier in Englisch, Fließtext in Deutsch. Aktualität: Versionen können sich seit dieser Recherche verschoben haben — als veränderlich markierte Punkte vor Implementierung gegen die Quellen prüfen.

Inhaltsverzeichnis:
1. [Architektur-Überblick: CLI vs. SDK vs. Managed Agents](#1-architektur-überblick)
2. [Headless / programmatischer Betrieb (claude CLI)](#2-headless--programmatischer-betrieb-claude-cli)
3. [Das stream-json-Event-Format (Output) mit Beispiel-JSON](#3-stream-json-event-format-output)
4. [Bidirektionale Interaktion (input stream-json, Rückfragen an den Menschen)](#4-bidirektionale-interaktion-input-stream-json)
5. [Permission-Modes & canUseTool / Permission-Prompts](#5-permission-modes--canusetool)
6. [Hooks (Lifecycle-Events fürs Status-Tracking)](#6-hooks)
7. [Subagents, Slash-Commands, Skills, Output-Styles, Plugins, settings.json, CLAUDE.md](#7-konfigurations-bausteine)
8. [MCP-Integration aus Sicht von Claude Code](#8-mcp-integration)
9. [Das offizielle Agent SDK (TypeScript) — API im Detail](#9-agent-sdk-typescript)
10. [Auth: Subscription-OAuth vs. API-Key + Kostenmodell](#10-auth--kostenmodell)
11. [Aktuelle Modelle (IDs + Pricing)](#11-aktuelle-modelle)
12. [Caveats für mads-Dashboard (Live-Output, „braucht Input", Fortschritt, Token/Kosten)](#12-caveats-für-mads)
13. [Quellen](#13-quellen)

---

## 1. Architektur-Überblick

Es gibt drei Wege, Claude programmatisch laufen zu lassen. Für mads ist **(A) Agent SDK in einem Node-Sidecar** der relevanteste Weg, weil mads selbst die Worktrees/Branches verwaltet und auf der lokalen Maschine arbeitet.

| Weg | Läuft in | Schnittstelle | Tools laufen auf | Für mads |
| --- | --- | --- | --- | --- |
| **A) Agent SDK (TS/Python)** | eigenem Prozess, eigene Infrastruktur | Library `query()` | lokaler Maschine (Worktree) | **Primärweg** — voller programmatischer Zugriff, canUseTool-Callback, Hooks-Callbacks, MCP in-process |
| **B) `claude -p` CLI** | Subprozess | stdin/stdout JSONL | lokaler Maschine | Alternative/Fallback; identische Capabilities, andere Schnittstelle |
| **C) Managed Agents (REST)** | Anthropic-Infrastruktur | REST + SSE | Anthropic-Sandbox-Container | NICHT geeignet (Dateien liegen in der Cloud, nicht im lokalen Worktree) |

Wichtig: Das TS-SDK ist im Grunde ein typsicherer Wrapper um genau die CLI. Es startet intern ein natives Claude-Code-Binary als Subprozess und spricht über das stdio-Control-Protokoll (stream-json + control_request/control_response) mit ihm. Das SDK-Paket **bündelt das Binary** als optionale Dependency — man muss Claude Code **nicht** separat installieren.

Quelle: <https://code.claude.com/docs/en/agent-sdk> (Agent SDK overview, „The TypeScript SDK bundles a native Claude Code binary for your platform as an optional dependency").

---

## 2. Headless / programmatischer Betrieb (`claude` CLI)

Non-interaktiver Betrieb: `-p` / `--print` an jeden `claude`-Aufruf anhängen. Alle CLI-Flags funktionieren mit `-p`.

```bash
claude -p "Find and fix the bug in auth.py" --allowedTools "Read,Edit,Bash"
```

### 2.1 Die wichtigsten Flags (für mads relevant)

| Flag | Bedeutung |
| --- | --- |
| `--print`, `-p` | Non-interaktiv: Antwort ausgeben, dann beenden |
| `--output-format <text\|json\|stream-json>` | Ausgabeformat. `stream-json` = NDJSON (eine JSON-Zeile pro Event) |
| `--input-format <text\|stream-json>` | Eingabeformat für Print-Mode. `stream-json` = bidirektional über stdin |
| `--include-partial-messages` | Partielle Streaming-Events (Token-Deltas) ausgeben. **Erfordert** `--print` + `--output-format stream-json` |
| `--verbose` | Volle turn-by-turn-Ausgabe. Wird für `stream-json` mit Partials i.d.R. mitgegeben |
| `--include-hook-events` | Alle Hook-Lifecycle-Events in den Stream aufnehmen. Erfordert `--output-format stream-json` |
| `--replay-user-messages` | User-Messages von stdin auf stdout zurückspielen (Acknowledgment). Erfordert in+out stream-json |
| `--resume <id\|name>`, `-r` | Bestimmte Session per ID/Name fortsetzen |
| `--continue`, `-c` | Jüngste Session im aktuellen Verzeichnis fortsetzen |
| `--session-id <uuid>` | Konkrete Session-ID vorgeben (muss valide UUID sein) |
| `--fork-session` | Beim Resume neue Session-ID erzeugen statt die alte wiederzuverwenden |
| `--permission-mode <mode>` | Startmodus: `default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions` |
| `--permission-prompt-tool <mcp_tool>` | MCP-Tool, das Permission-Prompts im non-interaktiven Modus behandelt |
| `--allowedTools`, `--allowed-tools` | Tools, die ohne Prompt laufen (Permission-Rule-Syntax, z.B. `"Bash(git log *)"`) |
| `--disallowedTools`, `--disallowed-tools` | Deny-Rules; bare Name entfernt das Tool aus dem Kontext (`"Edit"`, `"mcp__*"`) |
| `--tools` | Welche **built-in** Tools verfügbar sind (`""`=keine, `"default"`=alle, `"Bash,Edit,Read"`) |
| `--append-system-prompt <text>` | Text an den Default-System-Prompt anhängen |
| `--append-system-prompt-file <path>` | Datei an den System-Prompt anhängen |
| `--system-prompt <text>` / `--system-prompt-file` | Default-System-Prompt komplett ersetzen |
| `--mcp-config <json\|file>` | MCP-Server aus JSON laden (space-separierte Liste) |
| `--strict-mcp-config` | Nur MCP-Server aus `--mcp-config`, alle anderen ignorieren |
| `--model <alias\|id>` | Modell: `opus`, `sonnet`, `haiku`, `fable` oder volle ID |
| `--fallback-model <list>` | Komma-Liste von Fallback-Modellen bei Überlast/Retirement |
| `--add-dir <paths...>` | Zusätzliche Arbeitsverzeichnisse (Lese-/Schreibzugriff) |
| `--agents <json>` | Subagents dynamisch per JSON definieren |
| `--agent <name>` | Bestimmten Agenten für die Session wählen |
| `--setting-sources <user,project,local>` | Welche Settings-Quellen geladen werden |
| `--settings <file\|json>` | Settings-JSON laden (überschreibt gleiche Keys für diese Session) |
| `--max-turns <n>` | Agentic-Turns begrenzen (Print-Mode) |
| `--max-budget-usd <n>` | Max. USD-Ausgabe, dann Stopp (Print-Mode) |
| `--bare` | Schnellstart: kein Auto-Discovery von Hooks/Skills/Plugins/MCP/CLAUDE.md |
| `--worktree <name>`, `-w` | Start in isoliertem Git-Worktree unter `<repo>/.claude/worktrees/<name>` |
| `--json-schema <schema>` | Validierter JSON-Output nach Schema (structured outputs) |

### 2.2 Hintergrund-Session-Management (interessant für mads-Orchestrierung)

Claude Code hat eingebaute Verwaltung von Hintergrund-Sessions (ein „Supervisor"-/Daemon-Prozess). Das könnte für mads eine Alternative/Inspiration sein, ist aber UNVERIFIZIERT als robuste programmatische Steuer-API — Anthropic dokumentiert es primär als interaktives Feature:

- `claude --bg "<task>"` — startet als Hintergrund-Agent, gibt Session-ID zurück
- `claude agents --json` / `--json --all` — aktive (und beendete) Sessions als JSON für Scripting
- `claude attach <id>`, `claude logs <id>`, `claude stop <id>`, `claude respawn <id>`, `claude rm <id>`
- `claude daemon status`, `claude daemon stop --any [--keep-workers]`

Für mads empfohlen: **eigene Orchestrierung über das SDK** (ein `query()` pro Sub-Agent), weil das volle Kontrolle über Permission-/Hook-Callbacks und Event-Stream gibt. Das Background-Session-System ist eher für CLI-Nutzer gedacht.

---

## 3. stream-json Event-Format (Output)

Mit `--output-format stream-json --verbose [--include-partial-messages]` schreibt die CLI **eine JSON-Zeile pro Event** (NDJSON/JSONL). Jede Zeile hat ein `type`-Feld, oft `subtype`, plus Payload.

> WICHTIG (Doku-Lücke): Anthropic dokumentiert (Stand der Recherche) NICHT jeden einzelnen Event-Typ erschöpfend an einer Stelle — es gibt offene GitHub-Issues dazu (#24612, #24596, #24594). Die folgenden Shapes sind aus offizieller Headless-Doku + SDK-Typdefinitionen + Community-Referenz (takopi.dev) zusammengetragen und teils als **UNVERIFIZIERT** zu prüfen, wenn mads sich darauf hart verlässt.

### 3.1 Top-Level Event-Typen

| `type` | `subtype` | Wann | Wichtige Felder |
| --- | --- | --- | --- |
| `system` | `init` | erstes Event der Session | `session_id`, `cwd`, `model`, `permissionMode`, `apiKeySource`, `tools[]`, `mcp_servers[]`, (`plugins[]`, `plugin_errors[]`) |
| `system` | `api_retry` | vor einem Retry bei retrybarem API-Fehler | `attempt`, `max_retries`, `retry_delay_ms`, `error_status`, `error`, `uuid`, `session_id` |
| `system` | `plugin_install` | nur wenn `CLAUDE_CODE_SYNC_PLUGIN_INSTALL` gesetzt | `status` (`started`/`installed`/`failed`/`completed`), `name`, `error` |
| `assistant` | — | Assistant-Nachricht (Text oder tool_use) | `message` (Anthropic-Message-Objekt mit `content[]`, `usage`), `session_id` |
| `user` | — | tool_result(s) als User-Turn | `message.content[]` (mit `tool_result`-Blöcken) |
| `stream_event` | — | partielles Streaming-Event (nur mit `--include-partial-messages`) | `event` (verschachteltes Anthropic-Stream-Event, z.B. `content_block_delta`) |
| `result` | `success` / `error_max_turns` / `error_max_budget_usd` / `error_during_execution` / `error` | letztes Event | `total_cost_usd`, `usage`, `num_turns`, `duration_ms`, `duration_api_ms`, `result`, `is_error`, `permission_denials[]`, `session_id` |

### 3.2 Beispiel-JSON je Event

**system / init** (erste Zeile — hier liest mads `session_id`, `model`, geladene Tools/MCP):
```json
{
  "type": "system",
  "subtype": "init",
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "cwd": "/repo/.claude/worktrees/agent-3",
  "model": "claude-opus-4-8",
  "permissionMode": "default",
  "apiKeySource": "none",
  "tools": ["Bash", "Read", "Write", "Edit", "Glob", "Grep"],
  "mcp_servers": [{"name": "github", "status": "connected"}]
}
```

**assistant (Text):**
```json
{
  "type": "assistant",
  "session_id": "550e8400-...",
  "message": {
    "id": "msg_1",
    "type": "message",
    "role": "assistant",
    "content": [{"type": "text", "text": "Planning the refactor."}],
    "usage": {"input_tokens": 120, "output_tokens": 45}
  }
}
```

**assistant (tool_use)** — hier sieht mads, welches Tool der Agent aufrufen will (Fortschritts-/Schritt-Anzeige):
```json
{
  "type": "assistant",
  "session_id": "550e8400-...",
  "message": {
    "id": "msg_2",
    "role": "assistant",
    "content": [{"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {"command": "npm test"}}]
  }
}
```

**user (tool_result):**
```json
{
  "type": "user",
  "session_id": "550e8400-...",
  "message": {
    "role": "user",
    "content": [{"type": "tool_result", "tool_use_id": "toolu_1", "content": "All tests passed"}]
  }
}
```

**stream_event (partielles Text-Delta)** — Token-für-Token Live-Ausgabe fürs Terminal:
```json
{
  "type": "stream_event",
  "session_id": "550e8400-...",
  "event": {
    "type": "content_block_delta",
    "index": 0,
    "delta": {"type": "text_delta", "text": "Refac"}
  }
}
```
Filter-Beispiel (nur Text-Deltas, Tokens fortlaufend):
```bash
claude -p "Write a poem" --output-format stream-json --verbose --include-partial-messages \
  | jq -rj 'select(.type == "stream_event" and .event.delta.type? == "text_delta") | .event.delta.text'
```

**result (success)** — hier liest mads Kosten/Token/Dauer/Turns:
```json
{
  "type": "result",
  "subtype": "success",
  "session_id": "550e8400-...",
  "is_error": false,
  "duration_ms": 12345,
  "duration_api_ms": 12000,
  "num_turns": 7,
  "total_cost_usd": 0.0123,
  "result": "Done. Fixed the bug and added a test.",
  "usage": {"input_tokens": 1500, "output_tokens": 700}
}
```

**result (error mit permission_denials):**
```json
{
  "type": "result",
  "subtype": "error_during_execution",
  "is_error": true,
  "permission_denials": [
    {"tool_name": "Bash", "tool_use_id": "toolu_9", "tool_input": {"command": "git push --force"}}
  ]
}
```

Die Stream-Event-Subtypen (Anthropic-API-Ebene, verschachtelt unter `stream_event.event`): `message_start`, `content_block_start`, `content_block_delta` (`text_delta`, `thinking_delta`, `input_json_delta`), `content_block_stop`, `message_delta`, `message_stop`.

---

## 4. Bidirektionale Interaktion (input stream-json)

Für „Sub-Agent stellt Rückfrage an den Menschen" und Follow-up-Nachrichten an einen **laufenden** Agenten.

### 4.1 Über das CLI (`--input-format stream-json`)

Man startet `claude -p --input-format stream-json --output-format stream-json --verbose` und schreibt **User-Messages als JSON-Zeilen auf stdin**. Der Prozess bleibt am Leben, solange stdin offen ist, und verarbeitet die Nachrichten in Reihenfolge.

User-Message-Shape auf stdin (eine Zeile):
```json
{"type":"user","message":{"role":"user","content":"Now also update the README"},"parent_tool_use_id":null}
```

> **Doku-Lücke (UNVERIFIZIERT im Detail):** Das exakte stdin-Shape ist offiziell nur knapp dokumentiert (GitHub-Issue #24594). Aus der SDK-Implementierung ist das Shape `{type:"user", message:{role:"user", content:<string|blocks>}, parent_tool_use_id:null}`. `content` kann auch ein Array von Content-Blöcken sein (inkl. `image`). Mit `--replay-user-messages` spiegelt die CLI gesendete User-Messages auf stdout zurück (Acknowledgment).

### 4.2 Das Control-Protokoll (was unter der Haube läuft)

Zwischen Host (SDK/mads-Sidecar) und CLI läuft über stdio zusätzlich zum Message-Stream ein **Control-Protokoll** (`control_request` / `control_response`). Darüber werden u.a. abgewickelt:
- **Permission-Requests** (CLI fragt den Host: „darf Tool X mit Input Y?") → Host antwortet mit allow/deny (siehe §5)
- **interrupt**, **setPermissionMode**, **setModel**, MCP-Status, etc.

In der Praxis muss mads das Protokoll NICHT von Hand implementieren — das **SDK** kapselt es (canUseTool-Callback, `q.interrupt()`, `q.setPermissionMode()`). Wenn mads stattdessen direkt das CLI fährt, muss es das Control-Protokoll selbst sprechen, was deutlich mehr Aufwand ist. **Empfehlung: SDK verwenden.**

### 4.3 Über das SDK (empfohlen) — Streaming Input Mode

Wenn `prompt` ein `AsyncIterable<SDKUserMessage>` ist, geht das SDK in den **Streaming Input Mode** (der empfohlene Modus). Dann kann mads:
- mehrere Nachrichten nacheinander schicken (queue),
- Bilder anhängen,
- den Agenten unterbrechen (`q.interrupt()`),
- Permission-Requests live empfangen und beantworten.

```typescript
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

async function* userInput(): AsyncGenerator<SDKUserMessage> {
  yield { type: "user", message: { role: "user", content: "Analyze this codebase" }, parent_tool_use_id: null };
  // ... später, z.B. nachdem der Mensch im mads-Dashboard geantwortet hat:
  yield { type: "user", message: { role: "user", content: "Yes, proceed with option B" }, parent_tool_use_id: null };
}

const q = query({ prompt: userInput(), options: { /* ... */ } });
for await (const msg of q) { /* Events verarbeiten */ }
```

Für „Agent fragt den Menschen" gibt es zusätzlich das **`AskUserQuestion`**-Tool (built-in): Der Agent stellt Multiple-Choice-Rückfragen. Das ist der saubere, strukturierte Weg für mads, eine „braucht Input"-Rückfrage im Dashboard zu rendern (Optionen anzeigen, Antwort als nächste User-Message zurückschicken). Siehe <https://code.claude.com/docs/en/agent-sdk/user-input>.

---

## 5. Permission-Modes & canUseTool

### 5.1 Permission-Modes

| Mode | Was läuft ohne Nachfrage | Best für |
| --- | --- | --- |
| `default` | nur Reads | sensible Arbeit / volle Kontrolle |
| `acceptEdits` | Reads + File-Edits + gängige FS-Bash-Cmds (`mkdir`,`touch`,`mv`,`cp`,`rm`,`rmdir`,`sed`) im Arbeitsverzeichnis | Iterieren auf Code, den man per `git diff` reviewt |
| `plan` | nur Reads, **keine** Änderungen (nur Plan erstellen) | Codebase erkunden vor Änderungen |
| `auto` | alles, mit serverseitigem ML-Classifier als Sicherheitsnetz | lange Tasks, weniger Prompt-Fatigue (Research Preview) |
| `dontAsk` | nur vorab erlaubte Tools; alles andere wird **abgelehnt** (kein Prompt) | abgeschottete CI/Scripts |
| `bypassPermissions` | **alles** (nur explizite `ask`-Rules prompten noch; `rm -rf /` / `rm -rf ~` als Circuit-Breaker) | isolierte Container/VMs |

Wichtig für mads:
- In allen Modi außer `bypassPermissions` sind **Protected Paths** (`.git`, `.claude` (außer `.claude/worktrees`), `.vscode`, Shell-RC-Dateien, `.mcp.json`, `.npmrc` u.v.m.) nie auto-approved.
- `bypassPermissions` lässt sich aus Sicherheitsgründen **nicht** mitten in der Session aktivieren; muss beim Start gesetzt sein. Refuses to start als root/sudo (außer in erkannter Sandbox).
- `auto`-Mode hat harte Modell-/Plan-Anforderungen (u.a. Opus 4.6+ oder Sonnet 4.6) und ist Research Preview — für mads vorerst eher nicht als Default.

Da mads jeden Sub-Agent in einem eigenen Worktree fährt: Eine pragmatische Kombination ist `default` oder `acceptEdits` + **canUseTool-Callback** (siehe unten), sodass das mads-Dashboard die Hoheit über riskante Aktionen behält.

### 5.2 canUseTool — das Herzstück für „welcher Agent braucht Input"

Der `canUseTool`-Callback wird aufgerufen, wenn die Permission-Auswertung zu „ask" führt. Der Host (mads) entscheidet dann programmatisch (z.B. Dialog im Dashboard öffnen und auf Klick warten).

TypeScript-Signatur:
```typescript
type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: {
    signal: AbortSignal;
    suggestions?: PermissionUpdate[];
    blockedPath?: string;
    decisionReason?: string;
    toolUseID: string;
    agentID?: string;            // welcher Sub-Agent — wichtig fürs mads-Routing!
  }
) => Promise<PermissionResult>;

type PermissionResult =
  | { behavior: "allow"; updatedInput?: Record<string, unknown>; updatedPermissions?: PermissionUpdate[] }
  | { behavior: "deny"; message: string; interrupt?: boolean };
```

Beispiel (mads fragt den Menschen):
```typescript
const q = query({
  prompt: messageStream,
  options: {
    canUseTool: async (toolName, input, { toolUseID, agentID, signal }) => {
      // mads: Dialog im Dashboard für diesen agentID öffnen, auf Antwort warten
      const decision = await mads.askHumanForPermission({ agentID, toolName, input, toolUseID, signal });
      return decision.approved
        ? { behavior: "allow", updatedInput: decision.editedInput ?? input }
        : { behavior: "deny", message: decision.reason ?? "Denied by user" };
    }
  }
});
```

Voraussetzungen/Verhalten (aus der Python-Doku, gilt analog TS):
- `canUseTool` erfordert **Streaming Input Mode** (AsyncIterable-Prompt, nicht String).
- Nicht kombinierbar mit `permission_prompt_tool_name`; das SDK setzt intern `permission_prompt_tool_name="stdio"`.
- `behavior:"allow"` kann `updatedInput` (Tool-Input ändern) und `updatedPermissions` (Regeln updaten, z.B. „für diese Session immer erlauben") zurückgeben.
- `behavior:"deny"` mit `interrupt:true` bricht den Agenten ab.

### 5.3 Alternative: permission-prompt-tool (CLI, ohne SDK)

Wenn mads das CLI direkt fährt: `--permission-prompt-tool <mcp_tool>` benennt ein MCP-Tool, das Permission-Prompts beantwortet. Das ist die CLI-Variante des canUseTool-Mechanismus. Im SDK ist canUseTool bequemer.

---

## 6. Hooks

Hooks sind benutzerdefinierte Aktionen (Shell-Command, HTTP-Endpoint, MCP-Tool, Prompt, Agent) an Lifecycle-Punkten. Für mads das ideale Mittel für **Fortschritts-/Status-Tracking** pro Agent — ergänzend zum Event-Stream.

Im **SDK** werden Hooks als **Callback-Funktionen** registriert (nicht als Shell-Commands), was für mads sauberer ist:
```typescript
import { query, type HookCallback } from "@anthropic-ai/claude-agent-sdk";

const onPreTool: HookCallback = async (input) => {
  mads.trackStep(input);           // z.B. „Agent 3 will jetzt Bash ausführen"
  return {};                        // {} = nicht blockieren
};

const q = query({
  prompt: "...",
  options: {
    hooks: {
      PreToolUse:  [{ matcher: "Bash|Edit|Write", hooks: [onPreTool] }],
      PostToolUse: [{ matcher: "Edit|Write", hooks: [onFileChanged] }],
    }
  }
});
```
Mit `includeHookEvents: true` (SDK) bzw. `--include-hook-events` (CLI) werden Hook-Lifecycle-Events zusätzlich in den Message-Stream emittiert.

### 6.1 Hook-Events (Auswahl, relevant für mads)

| Event | Auslöser | Nutzen für mads |
| --- | --- | --- |
| `SessionStart` | Neue/forgesetzte Session | Kontext laden, Agent als „läuft" markieren |
| `UserPromptSubmit` | User reicht Prompt ein | Validieren/anreichern |
| `PreToolUse` | vor jedem Tool-Call | **Aktueller Schritt** („führt Bash aus"), gefährliche Cmds blocken/Input ändern |
| `PostToolUse` | nach erfolgreichem Tool-Call | Ergebnis validieren, Datei-Änderungen tracken |
| `PostToolUseFailure` | nach fehlgeschlagenem Tool-Call | Fehler loggen |
| `Notification` | Claude sendet Notification (z.B. Permission-Prompt, Auth) | **„braucht Input"-Signal** (Matcher `permission_prompt`, `elicitation_dialog`) |
| `Stop` | Claude antwortet fertig | Agent als „idle/fertig" markieren |
| `SubagentStart` / `SubagentStop` | Subagent gespawnt/fertig | Sub-Agent-Lifecycle im Dashboard |
| `SessionEnd` | Session endet | Cleanup |
| `PreCompact` / `PostCompact` | Kontext-Kompaktierung | Kontext-Status |
| `InstructionsLoaded` | CLAUDE.md / Rules geladen | Tracking |

(Weitere: `UserPromptExpansion`, `PermissionRequest`, `PermissionDenied`, `PostToolBatch`, `Setup`, `StopFailure`, `FileChanged`, `CwdChanged`, `ConfigChange`, `Elicitation`/`ElicitationResult`, `TaskCreated`/`TaskCompleted`.)

### 6.2 Hook-Konfiguration in settings.json (CLI-Weg)

Dreistufige Verschachtelung: Event → Matcher-Gruppe → Handler.
```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/check.sh", "timeout": 30 }
        ]
      }
    ]
  }
}
```
Handler-Typen: `command` (stdin=JSON), `http` (POST), `mcp_tool`, `prompt`, `agent`.

### 6.3 Hook-Input und -Output (Verhaltenssteuerung)

Jeder Hook erhält (stdin/POST-Body) u.a.: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `permission_mode`, plus event-spezifische Felder.

Steuer-JSON auf stdout (Exit 0):
```json
{
  "continue": true,
  "systemMessage": "Warnung an den Nutzer",
  "additionalContext": "Branch: main",
  "decision": "block",
  "reason": "Begründung",
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Destruktiver Befehl blockiert",
    "updatedInput": { "command": "safe alternative" }
  }
}
```
- Exit 0: stdout-JSON wird verarbeitet. Exit 2: Blocking-Error, stderr geht an Claude als Fehlermeldung.
- `PreToolUse.permissionDecision`: `allow` | `deny` | `ask` | `defer`.
- `continue:false` stoppt Claude komplett (`stopReason` an Nutzer).

---

## 7. Konfigurations-Bausteine

Das SDK lädt mit Default-Optionen filesystembasierte Konfiguration aus `.claude/` (Working Dir) und `~/.claude/`. Steuerbar über `settingSources` (TS) / `setting_sources` (Python).

| Feature | Ort | Beschreibung |
| --- | --- | --- |
| **CLAUDE.md** | `CLAUDE.md` oder `.claude/CLAUDE.md` | Projekt-Kontext/Instruktionen (Memory) |
| **Subagents** | `.claude/agents/*.md` | Spezialisierte Agenten (Frontmatter: `description`, `tools`, `model`, `permission-mode`, …, plus Prompt). Im SDK auch dynamisch via `agents`-Option |
| **Slash-Commands** | `.claude/commands/*.md` | Custom-Commands (Legacy-Format). Für neue Commands empfiehlt Anthropic Skills |
| **Skills** | `.claude/skills/*/SKILL.md` | Spezial-Fähigkeiten, on-demand geladen, oder per `/name` aufrufbar |
| **Output-Styles** | siehe `/output-styles` | Persistente Personas, projektweit teilbar/umschaltbar |
| **Plugins** | programmatisch via `plugins`-Option; bzw. `--plugin-dir`/`--plugin-url` | Bündeln Skills, Agents, Hooks, MCP-Server |
| **settings.json** | `~/.claude/settings.json` (user), `.claude/settings.json` (project, committable), `.claude/settings.local.json` (lokal, gitignored), Managed-Policy (Org) | Permissions, Hooks, env, defaultMode, model, … |

Settings-Präzedenz (grob): Managed-Policy > `--settings` (Session) > local > project > user.

### 7.1 Subagent-Definition (Datei)
```markdown
---
description: Expert code reviewer for quality and security reviews.
tools: [Read, Glob, Grep]
model: claude-sonnet-4-6
---
You are a code reviewer. Analyze code quality and suggest improvements.
```

### 7.2 Subagent-Definition (SDK, dynamisch)
```typescript
agents: {
  "code-reviewer": {
    description: "Expert code reviewer for quality and security reviews.",
    prompt: "Analyze code quality and suggest improvements.",
    tools: ["Read", "Glob", "Grep"]
  }
}
```
Subagents werden über das `Agent`-Tool aufgerufen → `Agent` in `allowedTools` aufnehmen, damit die Spawns auto-approved sind. Nachrichten aus dem Subagent-Kontext tragen `parent_tool_use_id` — damit kann mads Messages dem richtigen Subagent zuordnen.

> Hinweis für mads-Architektur: mads modelliert „Sub-Agents 1..N" als **eigene `query()`-Sessions in eigenen Worktrees** (echte Parallelität, eigene Branches). Das ist NICHT dasselbe wie Claude-Code-interne „Subagents" (die laufen innerhalb einer Session im selben Verzeichnis). Beide Konzepte können kombiniert werden, aber für mads' parallele Worktree-Agenten ist „ein `query()` pro Agent" der richtige Hebel.

---

## 8. MCP-Integration

Aus Sicht von Claude Code / SDK sind MCP-Server eine Quelle zusätzlicher Tools (`mcp__<server>__<tool>`).

- **SDK:** `mcpServers`-Option (TS) / `mcp_servers` (Python). Stdio-, SSE-/URL-Server.
  ```typescript
  mcpServers: {
    github: { type: "stdio", command: "github-mcp-server", args: [] },
    playwright: { command: "npx", args: ["@playwright/mcp@latest"] }
  }
  ```
- **CLI:** `--mcp-config <json|file>`, `--strict-mcp-config`, plus persistente Config in `.mcp.json` / settings.
- **Tool-Gating:** `allowedTools: ["github/*"]` bzw. `mcp__github__*`; Deny über `--disallowedTools "mcp__*"`.
- **Hook-Matching:** MCP-Tools matchen via `mcp__<server>__.*` in Hooks.
- **Query-Methoden (SDK):** `q.mcpServerStatus()`, `q.reconnectMcpServer()`, `q.toggleMcpServer()`, `q.setMcpServers()` — mads kann MCP-Server pro Agent zur Laufzeit verwalten.

---

## 9. Agent SDK (TypeScript)

### 9.1 Paket & Voraussetzungen

- **Paketname:** `@anthropic-ai/claude-agent-sdk` (Installation: `npm install @anthropic-ai/claude-agent-sdk`).
  - Hinweis: Das frühere Paket hieß `@anthropic-ai/claude-code`; im September 2025 umbenannt zu **claude-agent-sdk**. mads sollte das neue Paket nutzen.
- **Kein separates Claude-Code-Binary nötig:** Das TS-SDK bündelt ein natives Binary als optionale Dependency.
- **Node:** aktuelle LTS. (Python-Pendant: `pip install claude-agent-sdk`, Python ≥ 3.10.)

### 9.2 `query()` — Signatur
```typescript
function query({
  prompt,
  options
}: {
  prompt: string | AsyncIterable<SDKUserMessage>;   // String = single-shot, AsyncIterable = Streaming Input Mode
  options?: Options;
}): Query;   // Query extends AsyncGenerator<SDKMessage, void>
```

### 9.3 Wichtige `Options`-Felder (für mads)
```typescript
interface Options {
  // Modell & Verhalten
  model?: string;                               // z.B. "claude-opus-4-8" oder "opus"
  effort?: 'low'|'medium'|'high'|'xhigh'|'max';
  maxTurns?: number;
  maxBudgetUsd?: number;

  // Permissions & Tools
  permissionMode?: PermissionMode;              // 'default'|'acceptEdits'|'plan'|'auto'|'dontAsk'|'bypassPermissions'
  allowedTools?: string[];
  disallowedTools?: string[];
  canUseTool?: CanUseTool;                       // <-- zentral fürs mads-Permission-Dashboard
  tools?: string[] | { type: 'preset'; preset: 'claude_code' };

  // MCP & Agents
  mcpServers?: Record<string, McpServerConfig>;
  strictMcpConfig?: boolean;
  agents?: Record<string, AgentDefinition>;
  agent?: string;

  // Hooks
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  includeHookEvents?: boolean;

  // Session
  resume?: string;                              // Session-ID fortsetzen
  continue?: boolean;
  forkSession?: boolean;
  sessionId?: string;                           // eigene UUID vorgeben
  persistSession?: boolean;                     // default true

  // System-Prompt & Settings
  systemPrompt?: string | SystemPromptConfig;   // append/replace/preset
  settings?: string | Settings;
  settingSources?: SettingSource[];             // 'user'|'project'|'local'

  // Verzeichnisse (Worktree!)
  cwd?: string;                                 // <-- pro Agent: Pfad zum Worktree
  additionalDirectories?: string[];

  // Streaming & Output
  includePartialMessages?: boolean;             // <-- Live-Token-Stream fürs Terminal
  forwardSubagentText?: boolean;
  outputFormat?: { type: 'json_schema'; schema: JSONSchema };

  // Ausführung
  env?: Record<string, string | undefined>;     // <-- hier z.B. Auth-Env pro Agent setzen
  pathToClaudeCodeExecutable?: string;
  stderr?: (data: string) => void;
  abortController?: AbortController;             // <-- Agent abbrechen
}
```

### 9.4 `Query`-Objekt-Methoden (Steuerung laufender Agenten)
```typescript
interface Query extends AsyncGenerator<SDKMessage, void> {
  interrupt(): Promise<void>;                       // Agent unterbrechen (nur Streaming Input)
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model?: string): Promise<void>;
  streamInput(stream: AsyncIterable<SDKUserMessage>): Promise<void>;
  // Infos
  initializationResult(): Promise<...>;             // init-Daten (session_id etc.)
  supportedCommands(): Promise<SlashCommand[]>;
  supportedModels(): Promise<ModelInfo[]>;
  supportedAgents(): Promise<AgentInfo[]>;
  accountInfo(): Promise<AccountInfo>;
  // MCP
  mcpServerStatus(): Promise<McpServerStatus[]>;
  reconnectMcpServer(name: string): Promise<void>;
  toggleMcpServer(name: string, enabled: boolean): Promise<void>;
  setMcpServers(servers: Record<string, McpServerConfig>): Promise<void>;
  // File-Checkpointing
  rewindFiles(userMessageId: string, opts?: { dryRun?: boolean }): Promise<RewindFilesResult>;
  // sonstiges
  stopTask(taskId: string): Promise<void>;
  close(): void;
}
```
> UNVERIFIZIERT: Die exakte Methoden-Liste stammt aus der aktuellen TS-Referenz; einzelne Methoden (z.B. `rewindFiles`, `stopTask`, `accountInfo`) sollten gegen die installierte SDK-Version geprüft werden, da die API sich noch entwickelt.

### 9.5 SDKMessage-Typen (was über den Stream kommt)
```typescript
type SDKMessage =
  | SDKAssistantMessage         // type:"assistant"
  | SDKUserMessage              // type:"user"
  | SDKResultMessage            // type:"result"  (subtype: success | error_max_turns | error_max_budget_usd | error_during_execution)
  | SDKSystemMessage            // type:"system"  (subtype: init | ...)
  | SDKPartialAssistantMessage  // partielle Streaming-Updates
  | SDKToolProgressMessage
  | SDKTaskProgressMessage
  | SDKStatusMessage
  | SDKHookStartedMessage | SDKHookProgressMessage | SDKHookResponseMessage
  | SDKNotificationMessage
  | SDKPromptSuggestionMessage
  | SDKPermissionDeniedMessage
  | SDKRateLimitEvent
  | SDKMirrorErrorMessage;
```
Schlüssel-Felder:
```typescript
type SDKResultMessage = {
  type: "result";
  subtype: "success" | "error_max_turns" | "error_max_budget_usd" | "error_during_execution";
  session_id: string;
  num_turns: number;
  total_cost_usd: number;
  usage: { input_tokens: number; output_tokens: number };
  result: string;
};
```

### 9.6 Minimales Node-Skript (startet einen Agenten, emittiert Events)
```typescript
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

// Streaming Input ermöglicht canUseTool, interrupt() und Follow-ups
async function* input(): AsyncGenerator<SDKUserMessage> {
  yield { type: "user", message: { role: "user", content: "Fix the failing test in src/auth.ts" }, parent_tool_use_id: null };
}

const q = query({
  prompt: input(),
  options: {
    cwd: "/repo/.claude/worktrees/agent-3",   // eigener Worktree pro Sub-Agent
    model: "claude-opus-4-8",
    permissionMode: "default",
    includePartialMessages: true,             // Live-Token-Stream
    allowedTools: ["Read", "Edit", "Bash", "Grep", "Glob"],
    canUseTool: async (toolName, inputArgs, ctx) => {
      // mads: im Dashboard nachfragen; hier vereinfacht alles erlauben
      return { behavior: "allow" };
    },
    hooks: {
      PreToolUse: [{ matcher: "Bash|Edit|Write", hooks: [async (i) => { console.error("[step]", i); return {}; }] }]
    },
    stderr: (d) => process.stderr.write(d),
  }
});

for await (const msg of q) {
  switch (msg.type) {
    case "system":
      if (msg.subtype === "init") console.log("session", msg.session_id, "model", msg.model);
      break;
    case "stream_event":             // partielle Token-Deltas -> Live-Terminal
      // (msg.event.delta?.text)
      break;
    case "assistant":                // Text- oder tool_use-Block -> aktueller Schritt
      break;
    case "result":                   // Kosten/Token/Turns -> Dashboard
      console.log("cost $", msg.total_cost_usd, "turns", msg.num_turns, "usage", msg.usage);
      break;
  }
}
```

---

## 10. Auth & Kostenmodell

### 10.1 Auth-Methoden und Präzedenz

Claude Code wählt Credentials in dieser Reihenfolge (erste passende gewinnt):
1. **Cloud-Provider** (`CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` / `CLAUDE_CODE_USE_FOUNDRY`)
2. **`ANTHROPIC_AUTH_TOKEN`** (Bearer-Header; für LLM-Gateway/Proxy)
3. **`ANTHROPIC_API_KEY`** (X-Api-Key; direkter API-Zugriff, Console-Key). Im non-interaktiven `-p`-Modus immer genutzt, wenn gesetzt.
4. **`apiKeyHelper`** (Settings-Script, das einen Key zurückgibt; für rotierende Credentials)
5. **`CLAUDE_CODE_OAUTH_TOKEN`** (langlebiger OAuth-Token via `claude setup-token`; für CI/Scripts)
6. **Subscription-OAuth-Credentials** aus `/login` (Default für Pro/Max/Team/Enterprise)

### 10.2 Subscription-Auth programmatisch nutzen

- **`claude setup-token`** generiert einen ~1-Jahr-OAuth-Token (Pro/Max/Team/Enterprise nötig), den man als `CLAUDE_CODE_OAUTH_TOKEN` setzt. → So kann mads die bestehende Subscription des Nutzers für die Sub-Agenten verwenden, ohne Console-API-Key.
- Credentials-Speicher: macOS Keychain (für mads relevant, da macOS-Desktop-App).
- **Achtung Konflikt:** Wenn `ANTHROPIC_API_KEY` gesetzt ist, gewinnt der API-Key (nach Approval) über die Subscription — kann zu Auth-Fehlern führen, wenn der Key zu einer deaktivierten Org gehört. mads sollte pro-Agent-`env` kontrollieren (kein versehentliches `ANTHROPIC_API_KEY`).
- **`--bare`-Mode liest KEIN `CLAUDE_CODE_OAUTH_TOKEN`** — dort nur `ANTHROPIC_API_KEY` oder `apiKeyHelper`.

> **WICHTIGER Caveat (Agent-SDK-Lizenz):** Die offizielle Agent-SDK-Doku schreibt: „Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Please use the API key authentication methods described in this document instead." → Für ein **distribuiertes Produkt** auf SDK-Basis verlangt Anthropic also API-Key-Auth, nicht die claude.ai-Subscription. Für mads als **lokales Tool, das der Nutzer mit seiner eigenen Subscription betreibt** (CLI-Pfad, `CLAUDE_CODE_OAUTH_TOKEN` / `/login`), ist der Subscription-Weg vorgesehen — aber die genaue Abgrenzung „eigene Nutzung vs. angebotenes Produkt" ist juristisch zu klären. **Vor Release prüfen.**

### 10.3 Kostenmodell

- **API-Key (Console):** Pay-as-you-go nach Tokens (siehe §11). Jeder `result`-Event liefert `total_cost_usd` + per-Modell-Breakdown (bei `--output-format json`).
- **Subscription (Pro/Max/Team/Enterprise):** Nutzung läuft gegen das Abo-Kontingent/Rate-Limits; `total_cost_usd` ist dann eher Schätzwert/„as if API". mads sollte für Subscription-Nutzer die Token-Usage zeigen, aber Kosten als „im Abo enthalten" kennzeichnen.

---

## 11. Aktuelle Modelle

Quelle: claude-api-Skill-Katalog (cached 2026-05-26) + bestätigt durch CLI-Doku (Aliase `opus`, `sonnet`, `haiku`, `fable`).

| Modell | Model-ID (exakt) | Context | Max Output | Input $/1M | Output $/1M |
| --- | --- | --- | --- | --- | --- |
| Claude Fable 5 | `claude-fable-5` | 1M | 128K | $10.00 | $50.00 |
| **Claude Opus 4.8** | `claude-opus-4-8` | 1M | 128K | $5.00 | $25.00 |
| Claude Opus 4.7 | `claude-opus-4-7` | 1M | 128K | $5.00 | $25.00 |
| Claude Sonnet 4.6 | `claude-sonnet-4-6` | 1M | 64K | $3.00 | $15.00 |
| Claude Haiku 4.5 | `claude-haiku-4-5` | 200K | 64K | $1.00 | $5.00 |

Hinweise:
- IDs exakt verwenden, **keine** Datums-Suffixe anhängen (`claude-opus-4-8`, nicht `claude-opus-4-8-20xxxxxx`). Ausnahme Haiku hat auch eine datierte Variante `claude-haiku-4-5-20251001`.
- CLI-Aliase: `--model opus` → Opus-Default (aktuell 4.8), `sonnet` → Sonnet 4.6, `haiku` → Haiku 4.5, `fable` → Fable 5.
- Empfehlung für mads: Main/Integrator-Agent auf `claude-opus-4-8` (höchste Coding-/Agentic-Qualität), günstige/parallele Sub-Tasks ggf. `claude-sonnet-4-6`; Subagents/Explore ggf. `claude-haiku-4-5`.
- **UNVERIFIZIERT (Verfügbarkeit):** Mehrere Pricing-Quellen vom Juni 2026 erwähnen, dass Fable 5 zeitweise wegen einer US-Exportkontroll-Direktive für „foreign nationals" gesperrt wurde. Vor Einsatz von Fable 5 die aktuelle Verfügbarkeit prüfen.

---

## 12. Caveats für mads

Damit mads pro Agent (a) Live-Terminal-Output, (b) „braucht Input"-Signal, (c) Fortschritt/Schritt, (d) Token/Kosten anzeigen kann — und worauf zu achten ist:

### (a) Live-Terminal-Ausgabe
- **Hebel:** SDK-Option `includePartialMessages: true` (CLI: `--include-partial-messages --output-format stream-json --verbose`). Dann kommen `stream_event`/`SDKPartialAssistantMessage` mit `content_block_delta` (`text_delta`).
- Zusätzlich `stderr`-Callback (SDK) für Roh-Logs/Debug.
- **Caveat:** Ohne `includePartialMessages` bekommt mads nur ganze Assistant-Messages (kein Token-Streaming). Das Default-Verhalten ist NICHT partiell — explizit setzen.

### (b) „Braucht Input"-Signal
- **Primär:** `canUseTool`-Callback (SDK) — wird bei „ask" aufgerufen, blockiert bis mads antwortet. `ctx.agentID`/`toolUseID` zum Routing ins richtige Dashboard-Panel nutzen.
- **Strukturierte Rückfrage:** built-in Tool `AskUserQuestion` (Multiple-Choice) — Agent fragt aktiv den Menschen; Antwort als nächste User-Message zurückschicken.
- **Ergänzend:** `Notification`-Hook (Matcher `permission_prompt`, `elicitation_dialog`) als Status-Flag.
- **Caveat:** `canUseTool` setzt **Streaming Input Mode** voraus (AsyncIterable-Prompt). Mit reinem String-Prompt funktioniert es nicht. Außerdem nicht mit `permission_prompt_tool_name` kombinierbar.
- **Caveat:** Im `dontAsk`-Mode wird statt zu fragen abgelehnt; in `bypassPermissions` wird (fast) nichts gefragt. Für ein „Mensch im Loop"-Dashboard ist `default`/`acceptEdits` + `canUseTool` die richtige Wahl.

### (c) Fortschritt / aktueller Schritt
- **Hebel:** `assistant`-Events mit `tool_use`-Blöcken (welches Tool, welcher Input) + `user`-Events mit `tool_result`. Plus `PreToolUse`/`PostToolUse`-Hooks (Callbacks). Plus `SDKToolProgressMessage`/`SDKTaskProgressMessage`.
- **Caveat:** Das stream-json-Event-Schema ist offiziell nicht erschöpfend dokumentiert (offene GitHub-Issues #24612/#24596/#24594). mads sollte defensiv parsen (unbekannte `type`/`subtype` tolerieren) und an die installierte SDK-Version koppeln.

### (d) Token / Kosten
- **Hebel:** `result`-Event liefert `total_cost_usd`, `usage.{input_tokens,output_tokens}`, `num_turns`, `duration_ms`. Bei `--output-format json` zusätzlich per-Modell-Cost-Breakdown.
- **Caveat:** `total_cost_usd` ist bei **Subscription-Auth** ein „as-if-API"-Schätzwert, keine echte Abrechnung (Nutzung läuft gegen das Abo). Bei API-Key-Auth ist es die tatsächliche Spend.
- Optional `maxBudgetUsd` (SDK) / `--max-budget-usd` als harter Stopp pro Agent.

### Weitere mads-spezifische Punkte
- **Pro Agent = ein `query()` mit eigenem `cwd`** (Worktree-Pfad). Echte Parallelität, isolierte Branches. Das `Query`-Objekt bietet `interrupt()`, `setModel()`, `setPermissionMode()`, `setMcpServers()` zur Laufzeit-Steuerung.
- **Session-Resume:** `sessionId`/`resume`/`forkSession` — mads kann Agenten pausieren/fortsetzen; `session_id` aus dem `init`-Event speichern.
- **Protected Paths:** `.claude` ist protected (außer `.claude/worktrees`) — mads' Worktree-Strategie unter `.claude/worktrees/<name>` ist damit kompatibel.
- **Auth-Lizenz-Caveat (siehe §10.2):** Subscription-Login für ein angebotenes Produkt ist laut SDK-Doku ohne Vorab-Genehmigung nicht erlaubt — für mads als lokales, vom Nutzer mit eigener Subscription betriebenes Tool vor Release rechtlich abklären.

---

## 13. Quellen

Offizielle Anthropic-Doku (abgerufen 2026-06-19):
- Agent SDK Overview — <https://code.claude.com/docs/en/agent-sdk>
- Agent SDK TypeScript Reference — <https://code.claude.com/docs/en/agent-sdk/typescript>
- Streaming Input (Streaming vs Single Mode) — <https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode>
- Headless / programmatisch (`claude -p`) — <https://code.claude.com/docs/en/headless>
- CLI Reference (alle Flags) — <https://code.claude.com/docs/en/cli-reference>
- Hooks Reference — <https://code.claude.com/docs/en/hooks>
- Permission Modes — <https://code.claude.com/docs/en/permission-modes>
- Authentication — <https://code.claude.com/docs/en/authentication>
- User Input / AskUserQuestion — <https://code.claude.com/docs/en/agent-sdk/user-input>
- Sub-Agents — <https://code.claude.com/docs/en/sub-agents>

SDK-/Bibliotheks-Doku (Context7):
- Claude Agent SDK for Python (Typen, `query()`, `canUseTool`, Hooks) — `/anthropics/claude-agent-sdk-python` via Context7
- npm: `@anthropic-ai/claude-agent-sdk` — <https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk>
- TS-SDK CHANGELOG — <https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md>

Modelle/Pricing:
- claude-api-Skill-Katalog (cached 2026-05-26): exakte Model-IDs + Pricing
- Pricing-Querverweis (Juni 2026, teils UNVERIFIZIERT): metacto.com, finout.io, cloudzero.com

Community-Referenz (für stream-json-Shapes, ergänzend, NICHT offiziell):
- takopi.dev stream-json Cheatsheet — <https://takopi.dev/reference/runners/claude/stream-json-cheatsheet/>
- Offene Doku-Issues: anthropics/claude-code #24612, #24596, #24594 (stream-json/input-format Doku-Lücken)

Als UNVERIFIZIERT zu prüfen: exakte `Query`-Methodenliste, vollständige stream-json-Event-Subtypen, exaktes stdin-Shape für `--input-format stream-json`, Fable-5-Verfügbarkeit, Subscription-Auth-Lizenz für angebotene Produkte.
