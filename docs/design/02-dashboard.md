# 02 — Dashboard (Gesamtübersicht)

> **Status:** Design, implementierungsreif. Stand: 2026-06-22.
> **Sprache:** Deutsch (Fließtext), Englisch (Code/Identifier).
> **Zielprojekt:** **mads** — native macOS-App (Tauri 2 + React/TS, Rust-Core, Node-Sidecar
> mit dem offiziellen Claude Agent SDK). Ein Mensch arbeitet parallel mit einem
> **Main-Agent (= Integrator)** plus **Sub-Agents 1..N**, jeder auf eigener Git-Branch in
> eigenem Worktree, mit voller GitHub-Nutzung.

---

## 0. Zusammenfassung & Einordnung in die Gesamtarchitektur

Das **Dashboard** ist die zentrale Oberfläche von mads: *Auf einen Blick* sieht der Mensch,
wie viele Agenten laufen, **wer Input braucht**, **wo eine Eskalation ansteht** (CI rot,
Merge-Konflikt, push rejected, stale base, gh-Auth kaputt), wie der **Fortschritt** und der
**aktuelle Schritt** jedes Agenten ist (Terminal-artige Claude-Code-Ausgabe), plus ein
dedizierter **Main-Agent-/Integrator-Bereich**.

Das Dashboard ist **reine Anzeige- und Steuer-Schicht**: es erzeugt keine Git-/GitHub-Effekte
selbst, sondern sendet Tauri-Commands an den Rust-Core, der sie über NDJSON an den
Node-Sidecar weiterreicht. Damit operationalisiert das Dashboard die paix-Invarianten, ohne
ihnen zu widersprechen:

- **Only `main` merges.** Das Dashboard zeigt **Merge-Buttons ausschließlich im
  Main-Agent-Panel** (Integrator). Sub-Agent-Karten haben *keinen* Merge-Button — sie können
  nur „PR öffnen", „synchronisieren (rebase)", „lokales Gate" anstoßen. (paix §2, Invariante 1)
- **`main` is always runnable.** Das Dashboard rendert Vor-Merge-Gates (CI grün, Review
  approved, `mergeStateStatus ∈ {CLEAN, HAS_HOOKS}`) als harte Voraussetzung; ein roter oder
  stale-base PR ist im Integrator-Panel als „nicht merge-fähig" markiert. (paix §2/§7)
- **Subs never self-merge.** Jede außen-sichtbare Aktion (PR, Merge) ist eine explizite
  Mensch-Interaktion im UI; das Dashboard löst nie automatisch einen Merge aus. (paix §2)

**Querverweise (andere Design-Docs):**

- [[01-architecture]] — Gesamt-Topologie (Tauri-Core ↔ Sidecar ↔ N `query()`-Sessions),
  Prozess-Supervision, Event-Bus. Das Dashboard ist der UI-Konsument dieses Event-Bus.
- [[03-main-agent]] — Integrator-Rolle, Merge-Queue, Integrations-Reihenfolge,
  Konflikt-Routing. Das Main-Agent-Panel (§7 hier) ist die *View* darauf.
- [[04-sub-agents]] — Sub-Agent-Lebenszyklus, Rückfrage-Protokoll, GitHub-Interaktion; die
  Sub-Agent-Karten (§3 hier) sind die *View* darauf.
- [[10-navigation-toolbar]] — Activity-Rail (`activeView`/`ToolbarItem`-Registry), die dieses
  Dashboard-Layout **ersetzt** die alte Sidebar durch: der Default-Streams-View ist **Rail + Content
  (AgentGrid + Inspector)** ohne persistente Sidebar (Doc 10 §1a löst sie auf — die Stream-Liste war
  redundant mit dem `AgentGrid`); das Primary-Panel erscheint nur aktivitäts-spezifisch
  (Dateien/Settings). **„Änderungen" ist kein Primary-Panel**, sondern ein `position:fixed`-Overlay
  (Toggle `changeOverviewOn`, [[09-change-overview]] §1.4), das mit jeder View koexistiert.
  Streams-/Changes-Badges auf der Rail spiegeln die hier gezeigten Eskalations-/Kollisions-Zähler.
- [[sidecar-orchestration]] — NDJSON-Message-Set (`HostMessage`/`SidecarMessage`), aus dem
  alle Echtzeit-Daten dieses Dashboards stammen.
- [[github-multiagent]] — GraphQL-Polling, Eskalations-Signale, `gh`-Exit-Codes. Liefert die
  PR-/CI-/Merge-Status-Felder, die das Dashboard rendert.
- [[claude-code-capabilities]] — `canUseTool`/`AskUserQuestion`/Notification-Flows hinter der
  Inbox (§4/§5 hier).
- [[macos-design]] — Token, Materials, Vibrancy, Typo. Dieses Dokument referenziert
  die Token-Namen; ihre Definition lebt dort.

---

## 1. Zweck & Leitfragen, die das Dashboard in < 3 Sekunden beantwortet

| Leitfrage | Wo im UI beantwortet | Datenquelle |
|---|---|---|
| Wie viele Agenten laufen / sind idle / fertig? | Toolbar-Aggregat + Grid-Sektionszähler („Running"/„Idle/Done") | `status_update` (Sidecar) |
| **Wer braucht jetzt Input?** | „Needs-attention"-Sektion oben im Grid + Inbox-Badge + Rail-Badge auf „Streams" + Tray | `permission_request`, `needs_input` |
| **Wo ist eine Eskalation?** | Eskalations-Banner + rote Karten-Border + Eskalations-Spalte | `error` (Sidecar) + GraphQL-Signale ([[github-multiagent]]) |
| Was tut Agent X gerade? | Karten-Statuszeile (`currentStep`) + Live-Terminal | `status_update.currentStep`, `agent_event` |
| Wie viel kostet/dauert es? | Karten-Footer (Token/$), Toolbar-Aggregat | `cost_update` |
| Was steht zum Mergen an (Integrator)? | Main-Agent-Panel → Merge-Queue | GraphQL + Integrator-State ([[03-main-agent]]) |

---

## 2. Layout (macOS-HIG, NavigationSplitView-Muster)

mads gehört zur App-Klasse **Developer-Tool / Monitoring-Dashboard** (vgl. Xcode, Tower,
OrbStack). Das Layout folgt dem **Activity-Bar → (aktivitäts-spezifisches) Side-Panel → Content +
Inspector**-Muster (VS Code Side-Bar, Xcode-Navigator), siehe `macos-design.md` A.0 und
[[10-navigation-toolbar]] §1a. **Wichtig:** Der Default-Streams-View hat **keine persistente
Sidebar** — die frühere Stream-Sidebar war redundant mit dem `AgentGrid` und ist aufgelöst
([[10-navigation-toolbar]] §1a). Der Dashboard-Default ist **Activity-Rail + Content (AgentGrid +
Inspector)**; ein Mittel-Panel erscheint nur bei aktivitäts-spezifischen Views (Dateien/Settings)
— „Änderungen" ist davon ausgenommen (Overlay, kein Panel; [[09-change-overview]] §1.4,
[[10-navigation-toolbar]] LAYOUT-CONTRACT (g)). Konkret für den Streams-View:

```
┌───────────────────────────────────────────────────────────────────────────────────────┐
│ ●●●   mads · 6 agents (4 running · 1 needs input · 1 escalation)   [⟳ Sync all] [+ New] [⌥⌘I] │ ← Toolbar (vibrant, drag-region)
├────────┬───────────────────────────────────────────────────────────────┬─────────────────┤
│ RAIL   │  CONTENT (.main)                                               │  INSPECTOR       │
│ (Activ.│                                                                │  (tertiär,       │
│  -Rail,│  ┌── ⚠ ESCALATION BANNER (persistent) ──────────────────────┐ │   einklappbar)   │
│  vibr.)│  │ Agent „payments" — CI failed · [View diff]                │ │                  │
│        │  │                                   [Re-run CI] [Rebase]    │ │  Tabs:           │
│ ◆ mads │  └────────────────────────────────────────────────────────────┘ │  [Diff][Logs]    │
│        │                                                                │  [PR][Escal.]    │
│ ◇ Strm②│  ── NEEDS ATTENTION (sorted first) ──────────────────────────  │                  │
│ ▤ Dat. │  ┌──────────┐ ┌──────────┐                                     │  Agent: payments │
│ ⛁ Chg④ │  │ 🟡 auth   │ │ 🔴 paymnt │                                     │  Branch: feat/.. │
│ ⟳ Upd●│  │ waiting   │ │ escalation│                                     │  PR #142 BLOCKED │
│        │  │ Permission│ │ CI failed │                                     │  ───────────────  │
│ + New  │  └──────────┘ └──────────┘                                     │  + git diff /     │
│ ────── │  ── RUNNING ────────────────────────────────────────────────  │    xterm logs /   │
│ ⚙ Set. │  ┌──────────┐ ┌──────────┐ ┌──────────┐                        │    PR checks      │
│ ⓘ Über │  │ 🔵 search │ │ 🔵 docs   │ │ 🔵 refac. │                        │                  │
│ «       │  │ Bash:test │ │ Edit:md   │ │ Grep:...  │                        │                  │
│        │  └──────────┘ └──────────┘ └──────────┘                        │                  │
│        │  ── IDLE / DONE ────────────────────────────────────────────   │                  │
│        │  ┌──────────┐                                                   │                  │
│        │  │ 🟢 search │ … (collapsed group, inkl. „Erledigt · N")        │                  │
│        │  ╞═══════════════════════════════════════════════════════════╡ │                  │
│        │  ║ LIVE TERMINAL — [auth ▾] 🟡   [⌕ filter]  [↧ tail]         ║ │                  │
│        │  ║ $ npm test                                                  ║ │                  │
│        │  ║ ● Running 12/30 …                                          ║ │ ← xterm.js (opak)│
│        │  ╚═══════════════════════════════════════════════════════════╝ │                  │
├────────┴───────────────────────────────────────────────────────────────┴─────────────────┤
│ STATUS BAR:  ◷ Sidecar OK · gh ✓ · poll 23s · Σ $3.41 · 142k tok · 6 agents               │ ← Statusleiste
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

> Die **Inbox** (alle offenen Rückfragen, früher eine Sidebar-Sektion ③) bleibt als
> ⌘0-Overlay-Panel + „Needs attention"-Grid-Sektion erreichbar (§4.1) — sie braucht keine
> persistente Sidebar-Spalte. **PROJECT**/**Recent** (früher Sidebar-Box) leben jetzt im
> Rail-Eintrag „Projekt" + Popover ([[10-navigation-toolbar]] §1.3); der aktive `owner/repo` ist
> zusätzlich eine Titlebar-Pill. Die Stream-Liste *ist* das Grid — es gibt keine zweite.

**Layout-Regeln (HIG, aus `macos-design.md` A.1–A.5):**

| Bereich | Material / Verhalten | Quelle |
|---|---|---|
| Titlebar/Toolbar | `TitleBarStyle::Overlay`, durchlaufende Vibrancy, oben ein `data-tauri-drag-region`-Streifen | A.1 |
| Activity-Rail | `NSVisualEffectMaterial::Sidebar`-Look (`--sidebar-bg` + Vibrancy), ~176 pt aufgeklappt / ~52 pt nur-Icon, Kollaps-Toggle (**⌃⌘B**) — siehe [[10-navigation-toolbar]] §1.5 | A.2 |
| Primary-Panel (Mittel-Slot) | **nur aktivitäts-spezifisch** (Dateien/Settings); im Streams-View **nicht vorhanden** ([[10-navigation-toolbar]] §1a.5); „Änderungen" ist ein Overlay, kein Slot (§1.4 in 09) | A.0 |
| Content (Grid) | dezenter `WindowBackground` **oder** solider Hintergrund; Cards opak | A.5 |
| **Live-Terminal & Diff** | **opak, kein Vibrancy** (Lesbarkeit) | A.5 (Pflicht-Caveat) |
| Inspector | tertiäre Spalte, **zuerst ausgeblendet** bei schmalem Fenster, Toggle **⌥⌘I** | A.4 |
| Statusleiste | dünne opake Leiste, sekundäre Labels (inkl. Sidecar-Health, früher Sidebar-Foot) | A.8 |

**Responsives Kollabieren (Breakpoints):**

```
> 1200 pt:  Rail + (Primary-Panel falls aktiv) + Content + Inspector
900–1200:   Rail + Content (Inspector eingeklappt; Toggle holt ihn als Overlay)
< 900:      Rail auto-kollabiert (nur-Icon, Doc 10 OE-51); Content full-bleed; Min-Window 900×600 (tauri.conf min_inner_size)
```

> **OFFENE FRAGE (Layout):** Soll das **Live-Terminal-Panel** fest unten im Content angedockt
> sein (wie oben skizziert), oder als eigener Inspector-Tab leben? Variante A (angedockt)
> erlaubt „Grid + Terminal gleichzeitig", kostet aber vertikalen Platz. Variante B hält den
> Content rein für das Grid. Empfehlung des Autors: **angedockt + per Splitter höhenverstellbar
> + ⌃` zum Ein/Ausklappen.** Review soll bestätigen.

---

## 3. Agenten-Karte: Felder, Zustände, Ableitbarkeit

### 3.1 Datenmodell der Karte (Frontend-State)

Der Frontend-State pro Agent ist eine projizierte Sicht auf die Sidecar-Events. Der Rust-Core
**spiegelt** den vom Sidecar gemeldeten State (der **Sidecar-Pool ist autoritativ**, nicht der
Core — [[01-architecture]] §5.3) und pusht ihn als Snapshot + Deltas ans Frontend.

> **Status-Mapping (kanonisches Enum, [[01-architecture]] §5.1):** Das kanonische
> `AgentStatus`-Enum ist `starting | running | waiting_input | paused | escalation | error |
> done | queued`. Das hier verwendete `AgentLifecycle` ist die **UI-Projektion** davon:
> `starting`/`queued` → werden im Grid als „Running"/„queued"-Badge gezeigt (kein eigener
> Karten-Lifecycle); `paused` → wird als `idle` dargestellt; zusätzlich gibt es das
> **UI-only**-`merging` (nur für den Integrator während eines laufenden Merge). `waiting_input`,
> `escalation`, `running`, `done`, `error` sind 1:1 deckungsgleich.

```typescript
// Frontend-Modell einer Agenten-Karte (TS) — UI-Projektion von AgentStatus (siehe Mapping oben)
type AgentLifecycle =
  | "idle"             // gestartet, aber kein aktiver Auftrag (Stop-Hook gefeuert) / paused
  | "running"          // arbeitet (Tool-Aufrufe etc.); auch starting/queued
  | "waiting_input"    // canUseTool / AskUserQuestion / idle_prompt offen
  | "escalation"       // CI rot / Konflikt / push rejected / stale base / gh-Auth / max_budget / ownership_trespass
  | "merging"          // UI-only, NUR Main-Agent: führt gerade einen Merge aus
  | "done"             // result success, Input-Iterator geschlossen
  | "error";           // nicht-recoverable Sidecar-/Spawn-Fehler

interface AgentGitStatus {
  branch: string;                 // feat/<task>
  worktreePath: string;           // ~/mads-worktrees/<repo-slug>/<agentId>
  ahead: number;                  // git rev-list ... ahead
  behind: number;                 // > 0 => stale-base-Badge (paix §3/§5)
  pr?: {
    number: number;
    url: string;
    isDraft: boolean;
    mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
    mergeStateStatus:
      | "CLEAN" | "HAS_HOOKS" | "BEHIND" | "BLOCKED"
      | "DIRTY" | "DRAFT" | "UNSTABLE" | "UNKNOWN";
    reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
    ci: "SUCCESS" | "FAILURE" | "ERROR" | "PENDING" | "EXPECTED" | null;
  };
}

interface AgentProgress {
  // Es gibt KEINEN nativen Prozentwert (claude-code-capabilities.md §12c).
  kind: "determinate" | "indeterminate";
  // determinate NUR wenn echte Schätzung ableitbar (z.B. Test-Counter, Plan-Schritte):
  done?: number;
  total?: number;
  label: string;                  // "12/30 tests" | "Editing src/auth.ts" | "Thinking…"
}

interface AgentCard {
  agentId: string;
  title: string;                  // Stream-Name (vom Nutzer vergeben)
  lifecycle: AgentLifecycle;
  currentStep?: string;           // "Bash: npm test" (aus status_update.currentStep)
  currentTool?: string;           // "Bash" | "Edit" | "AskUserQuestion" | …
  progress: AgentProgress;
  cost: { totalUsd: number; numTurns: number;
          inputTokens?: number; outputTokens?: number;
          billing: "api" | "subscription" };  // subscription => $ = "as-if" (Caveat §12d capabilities)
  git: AgentGitStatus;
  openRequests: number;           // Anzahl offener permission/question für die Inbox-Badge
  lastEventAt: number;            // für „stale/hung"-Heuristik
  model: string;                  // claude-opus-4-8 etc.
}
```

```rust
// Rust-Core: kanonischer Zustand (gespiegelt aus Sidecar-Events)
#[derive(Clone, Serialize)]
pub enum AgentLifecycle { Idle, Running, WaitingInput, Escalation, Merging, Done, Error }

#[derive(Clone, Serialize)]
pub struct AgentCard {
    pub agent_id: String,
    pub title: String,
    pub lifecycle: AgentLifecycle,
    pub current_step: Option<String>,
    pub current_tool: Option<String>,
    pub progress: AgentProgress,
    pub cost: AgentCost,
    pub git: AgentGitStatus,
    pub open_requests: u32,
    pub last_event_at: i64,
    pub model: String,
}
```

### 3.2 Status-Ampel & Felder auf der Karte

```
┌──────────────────────────────────────┐
│ 🟡  auth                      ⋯  ⛶    │  ← Ampel + Titel + Kontextmenü + Detach-to-window (Post-MVP)
│ feat/auth-form · ↑3 ↓1               │  ← Branch + ahead/behind (↓1 => stale-base-Hinweis)
│ ───────────────────────────────────  │
│ ⏸ Waiting: permission „Bash"          │  ← currentStep / Status-Zeile
│ [▓▓▓▓▓░░░░░] 12/30 tests              │  ← determinate (nur wenn ableitbar), sonst Spinner
│ ───────────────────────────────────  │
│ PR #142  ⬤ BLOCKED · review required  │  ← PR-/Merge-/Review-/CI-Status (aus GraphQL)
│ $0.84 · 7 turns · 23k tok            │  ← Kosten/Token (subscription: „im Abo")
│ [Answer] [Open Terminal] [Open PR]   │  ← kontextuelle Mini-Aktionen
└──────────────────────────────────────┘
```

**Status-Farbsemantik (immer Farbe + Form/Icon + Label — nie Farbe allein, A11y, `macos-design.md` C.1/D):**

| `lifecycle` | Ampel | Lucide-Icon | Karten-Border | Sortier-Sektion |
|---|---|---|---|---|
| `idle` / `done` | grau / grün | `check-circle` | keine | „Idle / Done" (collapsed) |
| `running` | blau (Akzent, animiert*) | `refresh-cw` (rotierend*) | keine | „Running" |
| `waiting_input` | **gelb/orange** | `message-circle-question` | gelb (1px) | **„Needs attention"** (oben) |
| `escalation` | **rot** | `alert-triangle` | rot (2px) + leichtes Glow* | **„Needs attention"** (oben, vor waiting) |
| `merging` | violett | `git-merge` | violett | nur Main-Panel |
| `error` | rot (dunkel) | `x-octagon` | rot, gestrichelt | „Needs attention" |

`*` = Animation respektiert `prefers-reduced-motion` (siehe §11).

### 3.3 Fortschritt — was ist realistisch aus stream-json ableitbar?

Aus `claude-code-capabilities.md` §12c und `sidecar-orchestration.md` §4c: **Es gibt keinen
nativen Prozentwert.** Daher:

| Quelle | Ableitbar als | determinate möglich? |
|---|---|---|
| `num_turns` (steigt pro Turn) | „N turns" | nein (kein bekanntes Total) → **indeterminate** |
| Anzahl `tool_use`/`tool_result`-Paare | „N tools used" | nein → indeterminate |
| **Tool-Output-Parsing** (z.B. `12 passed, 18 to go`) | „12/30 tests" | **ja, heuristisch** → determinate |
| Plan-Mode-Schritte (Plan abhaken) | „3/5 plan steps" | **ja** → determinate |
| `agentProgressSummaries: true` (SDK-Option) | Progress-Text-Zeile | nein (Text) → indeterminate-Label |
| `currentStep` (`PreToolUse`-Hook) | „Editing src/auth.ts" | nein → **Mini-Status-Text statt Balken** |

**Design-Regel (HIG, `macos-design.md` C.4):** Determinate-Balken **nur** bei echter Schätzung
(Plan-Schritte, geparste Test-Counter). Sonst **indeterminate** (dezenter macOS-Spinner) +
ein **Mini-Status-Text** (`currentStep`) — letzterer ist meist wertvoller als ein
Pseudo-Prozent. Ein Pseudo-Balken wirkt unehrlich.

> **OFFENE FRAGE (Fortschritt):** Wie weit soll mads **Tool-Output-Parsing** für Determinate-
> Progress treiben? Test-Runner-Counter (`X passed, Y total`) sind brüchig (Framework-/
> Lokalisierungs-abhängig, vgl. die heuristische `gh push rejected`-Erkennung in
> `sidecar-orchestration.md` §9.3). Empfehlung: **nur Plan-Mode-Schritte** (robust) für
> v1-Determinate; Test-Counter als opt-in, in eine zentrale, erweiterbare Pattern-Tabelle
> auslagern. Review soll Scope festlegen.

---

## 4. „Braucht Input"-UX

Mehrstufige Hervorhebung vom dezentesten zum auffälligsten (aus `macos-design.md` C.2),
ausgelöst beim Übergang `running → waiting_input`:

1. **Badge** an der Karte (`openRequests`-Zähler) + **Rail-Badge auf „Streams"** (②, der
   Off-Dashboard-Awareness-Anker, [[10-navigation-toolbar]] §1a.6) + Inbox-Overlay-Zähler (⌘0)
   + **Tray-/Dock-Badge** (Aggregat „2 brauchen Input").
2. **Sortierung:** Karte rückt in die **„Needs attention"-Sektion** ganz oben; gelbe Border.
3. **Dezente Pulse-Animation** an der Ampel — **respektiert Reduced Motion** (§11).
4. **Native Notification** (Tauri `plugin-notification`, `macos-design.md` B.3) **nur beim
   Zustandswechsel**, nicht bei jedem Log-Tick. **Coalescing:** „2 Agenten brauchen Input"
   statt zwei Einzel-Pings innerhalb eines kurzen Fensters.
5. **Dock-Bounce** (`request_user_attention`, `macos-design.md` C.2, UNVERIFIZIERT — API
   prüfen) nur bei `escalation` oder optionaler „critical input"-Klasse, nicht bei jeder
   normalen Permission.

### 4.1 Inbox / Queue aller offenen Rückfragen (über alle Agenten)

Die **Inbox** ist die zentrale, agentenübergreifende Liste aller offenen Permission-Requests
und `AskUserQuestion`-Rückfragen. Sie ist als overlay-bares Panel (Shortcut **⌘0**) erreichbar
(mit der Auflösung der Sidebar entfällt die frühere Sidebar-Sektion — das ⌘0-Overlay + die
„Needs attention"-Grid-Sektion ersetzen sie vollständig), damit der Mensch sequenziell
„abarbeiten" kann, ohne zwischen
Karten zu springen.

```typescript
type InboxItemKind = "permission" | "ask_user_question" | "idle_prompt";

interface InboxItem {
  requestId: string;            // korreliert mit AnswerPermissionMsg.requestId ([[sidecar-orchestration]])
  agentId: string;
  agentTitle: string;
  kind: InboxItemKind;
  toolName?: string;            // "Bash" | "Write" | "AskUserQuestion" | …
  summary: string;             // human-readable, z.B. "Run: git push --force-with-lease"
  input?: Record<string, unknown>;       // Tool-Input (für Inline-Vorschau)
  blockedPath?: string;        // bei Protected-Path-Verstößen
  decisionReason?: string;
  suggestions?: unknown[];     // PermissionUpdate-Vorschläge (remember)
  questions?: Array<{          // nur bei AskUserQuestion
    question: string; header: string;
    options: Array<{ label: string; description: string; preview?: string }>;
    multiSelect: boolean;
  }>;
  receivedAt: number;
  riskHint?: "low" | "medium" | "high";  // z.B. Bash mit rm/force => high
}
```

**Inline-Beantwortung (kein modaler Vollbild-Dialog für Normalfälle):**

```
┌─ INBOX (3 open) ───────────────────────────────────────────────┐
│ ▸ 🟡 payments · Permission „Bash"                    [risk: high]│
│   Run: git push --force-with-lease origin feat/payments         │
│   [✓ Allow]  [✓ Allow & remember]  [✗ Deny]  [✎ Edit cmd]  [↳]  │
│─────────────────────────────────────────────────────────────────│
│ ▸ 🟡 search · AskUserQuestion                                    │
│   „Which migration strategy?"                                    │
│   ( ) Expand-contract   ( ) Big-bang   ( ) Defer  → [Submit]     │
│─────────────────────────────────────────────────────────────────│
│ ▸ 🟡 docs · idle_prompt — „Waiting for your next instruction"    │
│   [ type reply … ]                                       [Send]  │
└─────────────────────────────────────────────────────────────────┘
```

- **Permission:** `Allow` / `Allow & remember` (→ `remember: true`, setzt
  `updatedPermissions`) / `Deny` (mit optionaler Message) / `Edit` (öffnet `updatedInput`-Editor,
  z.B. um ein gefährliches Bash-Cmd zu entschärfen) — Mapping auf `AnswerPermissionMsg.decision`
  in [[sidecar-orchestration]].
- **AskUserQuestion:** strukturierte Optionen (Single-/Multi-Select je `multiSelect`) → Antwort
  als `answer_questions`-Decision zurück.
- **idle_prompt:** Freitext-Reply → `send_input` (Follow-up an laufenden Agenten).
- **`↳` (Open in context):** springt zur Karte + Live-Terminal des Agenten, falls mehr Kontext
  nötig ist.

**Wichtige Eigenschaft (aus `sidecar-orchestration.md` §4a):** Der `canUseTool`-Callback darf
**beliebig lange pending** bleiben — die Ausführung pausiert, bis der Mensch antwortet. Das
Dashboard muss also keinen Timeout erzwingen. Für *sehr* lange Wartezeiten (App-Quit) greift
die `defer`-Hook-Decision + späteres Resume (siehe [[claude-code-capabilities]] / §7.4 dort).

> **OFFENE FRAGE (Risk-Hint):** Die `riskHint`-Klassifikation (z.B. `Bash` mit
> `rm`/`--force`/`push -f` → `high`) ist heuristisch. Soll mads dafür eine eigene, lokale
> Pattern-Tabelle pflegen, oder die `decisionReason`/`blockedPath`-Signale des SDK genügen
> lassen? Empfehlung: kleine lokale Allowlist für offensichtlich destruktive Muster +
> SDK-Signale; nie auto-deny, nur visuelles Hervorheben.

---

## 5. Eskalations-UX

Eskalationen sind **persistente** Zustände (im Gegensatz zur transienten „braucht Input"-
Notification): sie bleiben sichtbar, bis sie behandelt sind. Quelle der Signale:
`github-multiagent.md` §4 (vier GraphQL-Signale + lokaler push-reject) und
`sidecar-orchestration.md` §4d (`SidecarErrorMsg`).

### 5.1 Eskalations-Klassifikation & empfohlene Aktionen

| Eskalation | Signal | UI-Anzeige | Empfohlene Aktion(en) im Banner/Karte |
|---|---|---|---|
| **CI rot** | `statusCheckRollup.state ∈ {FAILURE, ERROR}`; `gh pr checks` Exit `1`; `conclusion=failure` | rot, „CI failed" | [View failed checks] [Re-run CI] [Open Terminal] |
| **Merge-Konflikt** | `mergeable == CONFLICTING` **oder** `mergeStateStatus == DIRTY` | rot, „Merge conflict" | [Rebase onto main] [View diff] (paix §6 Protokoll) |
| **Stale base** | `mergeStateStatus == BEHIND`; lokal `behind > 0` | orange, „Behind main ↓N" | **[Rebase onto origin/main]** (der stale-base-Killer, paix §5) |
| **Push rejected** | `git push` Exit ≠ 0 + stderr `! [rejected]`/`non-fast-forward`/`fetch first` | rot, „Push rejected" | [Fetch + rebase + push --force-with-lease] |
| **Review-Gate offen** | `reviewDecision ∈ {REVIEW_REQUIRED, CHANGES_REQUESTED}` | gelb, „Review required" | [Open PR] [Review] (nur Integrator entscheidet) |
| **Branch-Protection-Block** | `mergeStateStatus == BLOCKED`; `gh pr merge` Protection-Fehler | gelb, „Blocked by protection" | [Show missing gates] |
| **gh-Auth kaputt** | `gh` Exit `4` (auth required) | rot, „GitHub auth required" | **[Re-authenticate gh]** (öffnet Auth-Flow, [[github-multiagent]] §7) |
| **Ownership-Trespass** | `SidecarErrorMsg{code:"ownership_trespass"}` (Trespass-Gate, [[06-ownership-and-coordination]]) | rot, „Region owned by other stream" + Befund (Datei · Symbol · Owner-Stream) | **[Request owner handoff]** / **[Land shared change first]** (Integrator verfügt; nie fremde Naht heimlich ändern) |
| **Spawn/Agent-Crash** | `SidecarErrorMsg{code:"spawn_failed"}` | rot, „Agent crashed" | [Restart agent] [View logs] |

**Wichtig (`github-multiagent.md` §9 Caveat 1):** `UNKNOWN` bei `mergeable`/`mergeStateStatus`
ist **kein** Alarm, sondern „lazy noch nicht berechnet" → das Dashboard zeigt einen
Re-Poll-Spinner (kurzer Re-Poll nach 1–3 s), **niemals** eine rote Eskalation. Sonst False
Positives.

### 5.2 Banner vs. Sheet/Alert (HIG, `macos-design.md` C.5)

- **Eskalations-Banner** (oben im Content, unter Toolbar, rotes/Warn-Material): persistent, mit
  klarer Primär-Aktion. Bei mehreren Eskalationen: gestapelt, neueste/dringlichste oben; ein
  „N escalations"-Kollaps wenn > 2.
- **Sheet/Alert** (modal) nur für **blockierende** Entscheidungen mit Datenverlust-Risiko
  (z.B. „Worktree mit uncommitted changes verwerfen?", „Force-push überschreibt Remote-History?").
  Default-Button rechts (Akzentfarbe); destructive rot.
- **Eskalations-Spalte (optional):** ein View-Toggle in der Toolbar schaltet das Grid in einen
  **Kanban-artigen Modus** mit Spalten `Needs input | Escalation | Running | Done`, sodass alle
  Eskalationen in einer Spalte gesammelt sind.
- **Koordinations-/Ownership-Panel (optional):** ein Panel, das das aktive
  `CoordinationArtifact` rendert — „wer besitzt welche Region" (Datei · Symbol/Pattern · Owner-
  Stream · `kind`) plus Trespass-Marker auf den verletzenden Streams. Liefert dem Menschen den
  Kontext für die `ownership_trespass`-Auflösung (Handoff / land-first). Quelle:
  [[06-ownership-and-coordination]]; Single-Writer ist der Integrator ([[03-main-agent]]).

> **Querverweis paix-Invariante:** Die *empfohlenen Aktionen* führen nie selbst zum Merge.
> „Rebase onto main" + „Re-run CI" sind Sub-Agent-Operationen ([[04-sub-agents]] `sync`/`gate`);
> der eigentliche Merge bleibt dem Integrator-Panel vorbehalten (paix §2/§7, siehe §7 hier).

---

## 6. Live-Terminal-Panel (xterm.js, macOS-Look)

Pro Agent ein eigenes `Terminal`-Instance, gebunden an seinen Sidecar-Stream
(`agent_event`-Deltas). Renderer-Stack aus `macos-design.md` C.3:

```typescript
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";   // Performance bei vielen Agenten
import { SearchAddon } from "@xterm/addon-search";

function makeTerminal(): Terminal {
  const term = new Terminal({
    fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',  // ui-monospace -> SF Mono in WebKit
    fontSize: 12,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 10_000,                 // Scrollback-Limit (Memory bei N Agenten)
    theme: {                            // macOS-„Basic/Dark"-angelehnt, an mads-Token angleichen
      background: "#1e1e1e", foreground: "#f5f5f7", cursor: "#f5f5f7",
      selectionBackground: "rgba(0,122,255,0.35)",   // System-Akzent
      black: "#000", red: "#ff5f57", green: "#28c840", yellow: "#febc2e",
      blue: "#007aff", magenta: "#bf5af2", cyan: "#5ac8fa", white: "#f5f5f7",
    },
  });
  term.loadAddon(new FitAddon());
  term.loadAddon(new WebglAddon());
  term.loadAddon(new SearchAddon());
  return term;
}
```

**Panel-Funktionen:**

- **ANSI-Farben wie Claude Code:** das xterm-Theme bildet die 16 ANSI-Farben + Akzent nach;
  ANSI-Escapes aus dem Agenten-Output werden 1:1 gerendert.
- **Umschalten zwischen Agenten:** Dropdown im Panel-Header (`[auth ▾]`) + **⌘1..9** springt
  zum Terminal von Agent N (`macos-design.md` A.9). Der Header zeigt die Ampel des aktiven
  Agenten.
- **Scrollback** (10k Zeilen, konfigurierbar), **Suche** (SearchAddon, **⌘F**), **Filter**
  (z.B. nur `tool_use`/Fehlerzeilen), **Tail-Toggle** („↧ tail" — auto-scroll an/aus).
- **Was wird gerendert:** `assistant_text`, `assistant_delta` (bei `includePartialMessages`),
  `tool_use`/`tool_result` (formatiert), `thinking` (gedämpft), plus Roh-`stderr` des
  `claude`-Subprozesses. Großvolumige `tool_result` (Diffs, Test-Logs) werden gekürzt
  dargestellt; Volltext auf Abruf aus dem Transcript (`sidecar-orchestration.md` §5.6).
- **Opak halten** — kein Vibrancy darunter (Lesbarkeit, `macos-design.md` A.5/C.3).
- **Virtualisierung:** Nur das **sichtbare** Terminal rendert aktiv; Hintergrund-Agenten
  bekommen `includePartialMessages: false` und einen leichtgewichtigen Ring-Buffer im Core,
  der beim Fokuswechsel ins xterm-Instance „replayed" wird (Lazy-Mount, §8 + `macos-design.md`
  C.3).

> **OFFENE FRAGE (Terminal-Persistenz):** Wo lebt der **Scrollback-Verlauf** bei Fokuswechsel
> und App-Neustart? Optionen: (a) nur im Frontend-xterm (verloren bei Unmount), (b) Ring-Buffer
> im Rust-Core (überlebt Fokuswechsel, nicht Neustart), (c) auf Platte (überlebt Neustart,
> deckt sich mit Transcript-Persistenz aus `sidecar-orchestration.md` §7). Empfehlung: **(b)
> für v1**, (c) optional via Transcript-Replay. Review soll Persistenz-Tiefe festlegen.

---

## 7. Main-Agent-Panel (Integrator)

> Vollständige Logik in [[03-main-agent]]; hier nur die **View** im Dashboard.

Der Main-Agent ist die mads-Verkörperung des **einen Integrators** (paix §2: *„genau EIN
Integrator merged"*). Seine Karte ist im Grid visuell vom Sub-Agent-Grid abgesetzt (eigener
`role-badge.integrator`-Akzent + eigene Grid-Sektion „● Main (Integrator)", `AgentGrid.tsx`) und
ist der **einzige Ort mit Merge-Aktionen** (im Inspector des selektierten Integrators).

```
┌─ MAIN AGENT — Integrator ─────────────────────────────────────────────┐
│ 🔵 running · "preparing merge of feat/auth"      model: claude-opus-4-8 │
│ ─────────────────────────────────────────────────────────────────────  │
│ MERGE QUEUE (serialisiert — nie parallel mergen, paix §7)              │
│  #  PR     Branch        gate                       order   action      │
│  1  #138   feat/schema   ✓CLEAN ✓APPROVED ✓CI       shared  [Merge]     │ ← „geteilter Code zuerst"
│  2  #142   feat/auth     ⬤BEHIND  → needs rebase     dep     [Rebase]    │
│  3  #145   feat/payments ✗CI failed                  dep     [blocked]   │
│  4  #147   feat/docs     ✓CLEAN ✓APPROVED ✓CI       indep   [Merge]     │
│ ─────────────────────────────────────────────────────────────────────  │
│ PENDING CONSOLIDATIONS                                                  │
│  • cross-cutting: import wiring (deferred) — 2 streams touch registry  │ ← paix §6 Muster 3
│  • shared-file conflict risk: pnpm-lock.yaml (search ↔ docs)           │ ← paix §6 / github §8
│ ─────────────────────────────────────────────────────────────────────  │
│ [Rebase next] [Merge next (squash, --delete-branch)] [Open merge log]  │
└────────────────────────────────────────────────────────────────────────┘
```

**Was das Panel zeigt (Mapping auf [[03-main-agent]] / `github-multiagent.md` §6):**

- **Integrator-Status:** aktueller Schritt des Main-Agenten (wie eine Agent-Karte, aber ohne
  eigene Feature-Branch — er arbeitet auf `main`-Checkout bzw. rebased Sub-Branches).
- **Merge-Queue-Übersicht:** alle offenen PRs mit Vor-Merge-Gate (`mergeStateStatus`,
  `reviewDecision`, `statusCheckRollup`) + **Integrations-Reihenfolge** (geteilter/fundamentaler
  Code zuerst, dann abhängige — paix §7). Reihenfolge ist sortier-/drag-bar, aber die
  *Empfehlung* kommt aus der Ownership-Map ([[04-sub-agents]]).
- **Anstehende Konsolidierungen:** deferred cross-cutting changes (Import-Wiring, Registry,
  Lockfile-Bumps) — die paix-„später konsolidieren"-Punkte (§6 Muster 3) + Shared-File-Risiken.
- **Aktionen:** `[Rebase next]` (rebase-before-merge, paix §7), `[Merge next]`
  (`gh pr merge --squash --delete-branch`, paix §7-Default), `[Open merge log]`.

**Harte UI-Regel (paix-Invariante):** Merge-Buttons existieren **ausschließlich** hier. Ein
PR ist nur dann mit aktivem `[Merge]` versehen, wenn
`mergeStateStatus ∈ {CLEAN, HAS_HOOKS} ∧ reviewDecision == APPROVED ∧ ci == SUCCESS` — sonst
`[blocked]` / `[Rebase]`. Stale-base (`BEHIND`) → kein Merge, erst `[Rebase]`. Damit ist „nie
rote-CI / stale-base mergen" mechanisch im UI verankert (paix §7).

---

## 8. Echtzeit-Datenfluss: Sidecar → Core → Frontend

```
 Node-Sidecar                Rust-Core (Tauri)                React-Frontend
 ────────────                ─────────────────                ──────────────
 query() events     Channel   line-buffered reader   Tauri      Channel.onmessage /
   per agent  ───────────▶   parse SidecarMessage  ────────▶  listen("agent:update")
   (stdout)   (\n-framed)    │ spiegelt AgentCard    events     │ Zustand (store)
                            │ (Sidecar-Pool autoritativ)      │ re-render (virtualisiert)
                            │ coalesce/throttle deltas        │
 stdin  ◀───────────────────┘  Tauri command -> writeLine    │ invoke("answer_permission")
        (HostMessage)          (host->sidecar NDJSON)  ◀──────┘  invoke("start_agent") …
```

**Transport (aus `sidecar-orchestration.md` §3 + `tauri2-stack.md`):**

1. **Sidecar → Core:** NDJSON über stdout, **eine JSON-Zeile pro Event**, `\n`-terminiert.
   Rust liest **line-buffered** (`BufReader::lines()`) — Events können über Chunk-Grenzen
   straddeln, daher Zeilenpuffer Pflicht. stdout ist *nur* Protokoll; alle Logs auf stderr.
2. **Core spiegelt den vom Sidecar gemeldeten Zustand** (`Map<agentId, AgentCard>` + Inbox +
   Escalations; der **Sidecar-Pool ist autoritativ**, [[01-architecture]] §5.3). Er
   **koalesziert** Status-Ticks, **bevor** er ans Frontend emittiert.
3. **Core → Frontend (kanonische Event-Topologie, OE-5 entschieden):**
   - **Terminal/Token-Stream:** `tauri::ipc::Channel<AgentOutput>` (**1 pro Agent**), nur für
     den **fokussierten** Agenten in voller Frequenz; Hintergrund-Agenten gepuffert.
   - **`agent:update`** — im Core **koalesziertes Delta-Event** (Status/Step/Cost/Git,
     ~30–60 ms Fenster), gedrosselt.
   - **`inbox:update`** / **`escalation:update`** — **separater High-Priority-Kanal/Event** für
     „braucht Input" und „Eskalation"; bei Zustandswechsel, **nicht koalesziert**, ungedrosselt.
4. **Frontend → Core → Sidecar:** Tauri-Commands (`invoke(...)`) → Core → `HostMessage` als
   NDJSON auf sidecar-stdin.

**Update-Frequenz & Backpressure (aus `sidecar-orchestration.md` §5):**

| Event-Klasse | Frequenz / Drosselung |
|---|---|
| Terminal-Token-Deltas (`assistant_delta`) | Koaleszenz-Fenster **~30–60 ms** pro Agent; nur fokussierter Agent in voller Auflösung |
| `status_update` / `currentStep` | bei Änderung, max. ~10/s gedrosselt |
| `cost_update` | bei `result`/Zwischenstand, ungedrosselt (selten) |
| `permission_request` / `needs_input` / `error` | **sofort**, ungedrosselt (UX-kritisch) |
| GraphQL-PR-Status ([[github-multiagent]]) | adaptiv 10–120 s, batched (ein Query alle PRs) |

- **stdout-Backpressure respektieren** (Node-Seite): `process.stdout.write()` → bei `false`
  auf `"drain"` warten; pro-Agent serielle Sende-Queue (`sidecar-orchestration.md` §5.2/5.3).
- **Bounded inbox** für Host→Sidecar.

**Virtualisierung bei vielen Agenten (Frontend):**

- **Karten-Grid:** virtualisierte Liste (nur sichtbare Karten gemountet); Sektions-Header
  („Needs attention / Running / Idle") als Sticky.
- **Terminals:** Lazy-Mount — nur das sichtbare `Terminal`-Instance lebt; Hintergrund-Agenten
  als leichter Ring-Buffer (§6). Concurrency-Limit der *aktiven* Agenten (4–8,
  `sidecar-orchestration.md` §5.5) → UI zeigt „queued" für überzählige.
- **Delta-Anwendung:** Frontend wendet `agent:update`-Deltas auf den Store an, kein
  Full-Snapshot pro Tick (außer beim initialen Load / Reconnect).

> **ENTSCHIEDEN (Event-Granularität / -Topologie, OE-5):** Der hochfrequente Terminal/Token-
> Stream läuft über `tauri::ipc::Channel<AgentOutput>` (1 pro Agent). Status-Updates gehen als
> **gebündeltes, im Core koalesziertes Delta-Event** (~30–60 ms Fenster) — kein eigenes
> Pro-Agent-Event, das bei vielen Agenten zu viele Events/s erzeugte. „braucht Input" und
> „Eskalation" laufen über einen **separaten High-Priority-Kanal/Event** (nicht koalesziert).
> Konsistent mit [[01-architecture]] §2.3/§6.

---

## 9. Interaktionen & Tastatur-Shortcuts

### 9.1 Aktionen (Karte / Toolbar / Kontextmenü)

| Aktion | Auslöser im UI | Command → Sidecar ([[sidecar-orchestration]]) | paix-Bezug |
|---|---|---|---|
| **Neuen Stream anlegen** | Toolbar `[+ New]` / **⌘N** | `start_agent` (+ Worktree `create`) | §5 create |
| Agent starten / fortsetzen | Karte / Resume-Banner | `start_agent` (ggf. `resumeSessionId`) | §7 reconnect |
| Agent pausieren | Karte / Kontextmenü | `interrupt_agent` | — |
| Agent stoppen | Karte / **⌘.** | `stop_agent` (`removeWorktree?`) | §5 cleanup |
| **Frage beantworten** | Inbox inline / **⌘0** | `answer_permission` | §4a input |
| Permission-Mode ändern | Karte / Inspector | `set_permission_mode` | §5 permissions |
| **Eskalation auflösen** | Banner-Aktion | je nach Typ: `sync`/`gate`/Re-run ([[04-sub-agents]]) | §5/§6 |
| PR öffnen | Karte `[Open PR]` | `pr(task)` ([[04-sub-agents]]) | §5 pr |
| **Merge (nur Integrator)** | Main-Panel `[Merge next]` | `integrate(task)` | §7 integrate |
| Sub-Agent-Fenster öffnen (Post-MVP) | Karte `⛶` / Doppelklick | Detach (eigenes Tauri-Window, Post-MVP) | — |
| Sync all | Toolbar `[⟳ Sync all]` | `sync` über alle aktiven | §5 sync |

**Sub-Agent-Fenster öffnen (Post-MVP):** Im MVP läuft alles in **einem Hauptfenster** mit N
xterm-Panes/Tabs ([[01-architecture]] §3.4, OE-3). Als **spätere optionale** Aktion kann ein
Agent als **eigenes Tauri-Window** abgedockt werden (großes Terminal + Inspector für einen
Fokus-Agenten); das Hauptfenster behält dann die Karte als „detached"-Platzhalter. (Nicht
native Window-Tabs — ein Fenster pro Detach, [[macos-design]] A.9.)

### 9.2 Tastatur-Shortcuts (HIG-konform, `macos-design.md` A.9)

| Shortcut | Bedeutung |
|---|---|
| **⌘N** | Neuer Agent / Stream |
| **⌘.** | Aktiven Agenten stoppen (Cancel) |
| **⌘0** | Inbox-Overlay öffnen/fokussieren |
| **⌘1** | View „Streams" (Content/Grid; **kein** Mittel-Panel) — Rücksprung-Anker ([[10-navigation-toolbar]] §8/§1a.6) |
| **⌘2 / ⌘…n** | Rail-Panels „Dateien" / weitere ([[10-navigation-toolbar]] §8) |
| **⇧⌘D** | „Änderungen" an/aus — Overlay-Toggle (`changeOverviewOn`), **kein** Panel ([[09-change-overview]] §8, [[10-navigation-toolbar]] §8) |
| **⌃`** | Live-Terminal-Panel ein/aus |
| **⌘F** | Suche (Terminal/Grid) |
| **⌃⌘B** | Activity-Rail ein-/ausklappen (ersetzt das frühere **⌃⌘S** „Sidebar ein/aus" — keine Sidebar mehr) |
| **⌥⌘I** | Inspector ein/aus |
| **⌘R** | Status/Polling neu laden |
| **⌘,** | Settings |
| **↑/↓ in Inbox** | nächste/vorige Rückfrage; **⏎** = Allow/Submit, **⌫** = Deny |

> Eigene Shortcuts überschreiben **keine** System-Shortcuts; alle erscheinen in den
> Menüeinträgen (macOS rendert sie automatisch). Native App-Menüleiste (File/Edit/View/Window/
> Help) ist Pflicht ([[macos-design]]).

---

## 10. Empty / Loading / Error-States

| State | Anzeige |
|---|---|
| **Empty (kein Agent)** | Zentrierte Illustration + „No agents running" + primärer `[+ New stream]`-Button + Kurz-Hint „Each stream runs on its own branch & worktree". |
| **Empty (kein Repo/Projekt)** | „Open a Git repository to start" + `[Open repo…]`; der Rail-Eintrag „Projekt" (Popover) ist der Einstieg zum Öffnen ([[10-navigation-toolbar]] §1.3). |
| **Loading (App-Start)** | Skeleton-Karten (graue Platzhalter) + Statusleiste „Connecting to sidecar…". Beim `sidecar_ready` mit `resumableAgents`: **Resume-Banner** „N agents can be resumed [Resume all] [Dismiss]" (`sidecar-orchestration.md` §7.2). |
| **Loading (PR-Status)** | Karten zeigen PR-Badge als Spinner solange `mergeStateStatus == UNKNOWN` (Re-Poll, **kein** Fehler — §5). |
| **Error (Sidecar down)** | Persistentes rotes Banner „Sidecar disconnected" + `[Restart sidecar]`; Karten gehen in „stale"-Look (gedimmt), keine Aktionen außer Restart. Core erkennt EOF auf stdout (`sidecar-orchestration.md` §7.5). |
| **Error (gh-Auth)** | Eskalations-Banner „GitHub auth required" + `[Re-authenticate]` (§5.1). |
| **Error (Agent-Crash)** | Karte rot „Agent crashed" + `[Restart]`; Auto-Restart mit Backoff (max. Retries), dann manuelle Eskalation (`sidecar-orchestration.md` §7.5). |
| **Stale/Hung-Heuristik** | Wenn `now - lastEventAt` > Schwelle bei `running`: dezenter „no activity for Nm"-Hinweis (kein Fehler, nur Info). |

---

## 11. Accessibility & Reduced Motion

Aus `macos-design.md` Teil D:

- **`prefers-reduced-motion: reduce`** → Pulse/Bounce/Spinner-Rotation aus oder durch
  Crossfade ersetzt; Status-Übergänge ohne Bewegung. CSS-Global-Reset + JS-Guard für
  xterm-Cursor-Blink-Reduktion.
- **`prefers-reduced-transparency: reduce`** → Activity-Rail-/Toolbar-Vibrancy durch **soliden**
  Hintergrund ersetzen, **sowohl** im CSS **als auch** das Vibrancy-Material zur Laufzeit
  deaktivieren ([[macos-design]]).
- **`prefers-contrast: more`** → Separatoren/Borders verstärken (Karten-Border, Ampel-Ring).
- **Farbe nie alleiniger Träger:** jeder Status hat Farbe **+ Icon + Text-Label** (§3.2,
  „Differentiate Without Color").
- **Fokus-Ringe** (`:focus-visible`) sichtbar; logische Tab-Reihenfolge: Toolbar → Activity-Rail →
  (Primary-Panel falls aktiv) → Grid (Karte für Karte) → Terminal → Inspector.
- **VoiceOver:** sinnvolle Labels für Ampeln („Agent auth, waiting for input"); **Live-Region**
  für eingehende „needs input"/Eskalations-Events, damit VoiceOver sie ansagt; Inbox-Items als
  Liste mit klaren Rollen.
- **Tastatur-Vollbedienbarkeit:** Inbox komplett per Tastatur abarbeitbar (§9.2), Grid-Navigation
  per Pfeiltasten.

---

## 12. Zusammenfassung der paix-Operationalisierung (Checkliste fürs UI)

| paix-Invariante / Regel | UI-Mechanik im Dashboard |
|---|---|
| **Only `main` merges** | Merge-Buttons nur im Main-Agent-Panel (§7); Sub-Karten haben keinen. |
| **`main` always runnable** | `[Merge]` nur aktiv bei `CLEAN/HAS_HOOKS + APPROVED + CI SUCCESS` (§7). |
| **Subs never self-merge** | Jede außen-sichtbare Aktion ist explizite Mensch-Interaktion; kein Auto-Merge. |
| **Stale base killer** | `↓N`-Badge + „Behind main"-Eskalation + `[Rebase onto origin/main]` (§3.2/§5). |
| **Serialisieren, nie parallel mergen** | Merge-Queue mit Reihenfolge, ein `[Merge next]` (§7). |
| **Geteilte Datei zuerst landen / Single-Owner** | „Pending consolidations" + Shared-File-Risiken im Main-Panel (§7). |
| **Nie rote-CI/stale-base PR mergen** | Vor-Merge-Gate sperrt den Button (§7); `UNKNOWN` ≠ Alarm (§5). |
| **Eskalation automatisch erkennen** | 4 GraphQL-Signale + push-reject → Eskalations-UX (§5). |

---

## Offene Fragen (für den Review gesammelt)

1. **Live-Terminal-Position** (§2): unten angedockt + höhenverstellbar (Empfehlung) vs.
   Inspector-Tab?
2. **Fortschritts-Heuristik** (§3.3): nur Plan-Schritte für Determinate (robust) vs. zusätzlich
   brüchiges Test-Counter-Parsing? Scope festlegen.
3. **Risk-Hint-Klassifikation** (§4.1): eigene lokale Pattern-Tabelle für destruktive Bash-Cmds
   vs. nur SDK-Signale (`blockedPath`/`decisionReason`)?
4. **Terminal-Persistenz-Tiefe** (§6): Frontend-only vs. Core-Ring-Buffer (Empfehlung) vs.
   On-Disk-Transcript-Replay?
5. **Tauri-Event-Granularität** (§8): pro-Agent-Event vs. gebündeltes Delta-Event mit
   Coalescing (Empfehlung) — gemeinsam mit [[01-architecture]] zu fixieren.
6. **Eskalations-Spalte als Default-View?** (§5.2): Kanban-Modus (`Needs input | Escalation |
   Running | Done`) als Default oder optionaler Toggle?
