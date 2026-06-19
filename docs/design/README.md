# mads — Design-Dokumentation (Index)

> **Status:** Design, implementierungsreif. Stand: 2026-06-19.
> **Sprache:** Deutsch (Fließtext), Englisch (Code/Identifier).
> Dieser Index bündelt die sechs Design-Dokumente von **mads**, erklärt die zentralen
> Begriffe und sammelt alle offenen Entscheidungen an einem Ort.

---

## Projektvision

**mads** (*multi-agent development studio*) ist eine native macOS-Desktop-App, in der
**ein Mensch parallel mit vielen Claude-Code-Agenten** entwickelt. Genau **ein** Main-Agent
fungiert als **Integrator** (der Einzige, der nach `main` merged), daneben laufen
**Sub-Agents 1..N**, jeder auf **eigener Git-Branch in eigenem Worktree**, mit voller
GitHub-Nutzung (PR-Lifecycle, Checks, Reviews, Merge-Queue). Der Nutzer bestimmt Anzahl
und Art der parallelen Streams.

Technisch besteht mads aus vier Schichten: **React/TS-Frontend** ↔ **Tauri-Rust-Core**
(IPC, Fenster, Persistenz, Notifications, Secret-Vermittlung) ↔ **Node-Sidecar**
(Orchestrator + offizielles Claude Agent SDK) ↔ **N Claude-Code-Agenten** auf
**Git-Worktrees + GitHub**.

mads **operationalisiert** die Invarianten des Multi-Agent-Leitfadens
([_paix-multi-agent-reference_](../research/_paix-multi-agent-reference.md)) und macht sie
**mechanisch erzwingbar und im UI sichtbar** statt nur als Disziplin:

1. **Only `main` merges** — kein Sub-Stream landet je selbst auf `main`.
2. **`main` is always runnable** — jeder Merge passiert deterministisches, grünes CI.
3. **Subs never self-merge** — außen-sichtbare Aktionen brauchen explizite Anweisung.

---

## Die sechs Design-Dokumente

| # | Dokument | In einem Satz |
|---|---|---|
| 01 | [Gesamtarchitektur](./01-architecture.md) | Schichtenmodell, Prozess-/Concurrency-Topologie, Datenmodell, IPC-Protokolle, Sicherheit, Tech-Stack und Roadmap — das Dach, auf das alle anderen Docs aufbauen. |
| 02 | [Dashboard](./02-dashboard.md) | Die zentrale Übersichts- und Steuer-Oberfläche (Sidebar + Agent-Grid + Inspector, Live-Terminal, Inbox, Eskalations- und Integrator-Panels) als reine Anzeige-/Steuer-Schicht über dem Event-Bus. |
| 03 | [Main-Agent (Integrator)](./03-main-agent.md) | Der Integrator als Hybrid aus deterministischer `IntegratorEngine` (Guards, Merge-Mechanik) und LLM-`query()`-Session (Urteilsfragen), inkl. Merge-Prozedur, Gates, Cron-Jobs und Eskalation. |
| 04 | [Sub-Agents](./04-sub-agents.md) | Der produzierende Entwicklungs-Stream: eine `query()`-Session pro Worktree/Branch, Lebenszyklus-Zustandsmaschine, Rückfrage-Protokoll, GitHub-Interaktion, Detailansicht (xterm-Pane; Detach Post-MVP), Permissions und Crash-Recovery. |
| 05 | [Update-Bereich](./05-update-area.md) | Read-mostly-Beobachter, der neue Claude-Code-/SDK-Fähigkeiten erkennt, LLM-bewertet und als GitHub-Issue vorschlägt; plus mads-Self-Update und Versions-Pinning. |
| 06 | [Region-Ownership & Koordination](./06-ownership-and-coordination.md) | Ownership auf Sub-Datei-Ebene (`OwnershipRule`/`CoordinationArtifact`) mit mechanischem Trespass-Gate (`detectTrespass` → `ownership_trespass`), das fremde Region-Edits *vor* dem Merge als Eskalation sichtbar macht. |

**Recherche-Inputs** (normative bzw. technische Quellen, referenziert von allen Docs):

- [_paix-multi-agent-reference_](../research/_paix-multi-agent-reference.md) — normative Multi-Agent-Invarianten und Worktree-/Integrations-Disziplin.
- [claude-code-capabilities](../research/claude-code-capabilities.md) — Agent SDK, `canUseTool`, Hooks, Permission-Modes, Modelle, Auth.
- [sidecar-orchestration](../research/sidecar-orchestration.md) — Sidecar-Pool, NDJSON-Protokoll, State-Maschine, Backpressure, Crash-Recovery.
- [github-multiagent](../research/github-multiagent.md) — gh/Octokit, Eskalations-Signale, Branch-Protection, Merge-Queue, Auth.
- [tauri2-stack](../research/tauri2-stack.md) — Channels vs. Events, Multi-Window, Plugins, Signing/Notarization, Updater.
- [macos-design](../research/macos-design.md) — HIG, Sidebar/Content/Inspector, Vibrancy, Update-Monitoring.

> **Verlinkung:** Die Docs verweisen untereinander mit `[[wikilink]]`s auf die tatsächlichen
> Dateinamen — Design-Docs als `[[01-architecture]]`…`[[06-ownership-and-coordination]]`, Recherche-Inputs als
> `[[claude-code-capabilities]]`, `[[tauri2-stack]]`, `[[sidecar-orchestration]]`,
> `[[github-multiagent]]`, `[[macos-design]]`, `[[_paix-multi-agent-reference]]`.

---

## Glossar zentraler Begriffe

| Begriff | Bedeutung in mads |
|---|---|
| **Integrator / Main-Agent** | Genau **ein** Agent mit `role: "integrator"`. Der einzige Akteur, der `gh pr merge` ausführt, die Integrations-Reihenfolge bestimmt und mechanische Konflikte löst. Realisiert als Hybrid: deterministische `IntegratorEngine` (führt den eigentlichen Merge aus) + LLM-`query()`-Session `MAIN_AGENT` (nur Urteilsfragen; `gh pr merge` steht bei ihm auf `disallowedTools`). Sein Worktree ist der `main`-Checkout. |
| **Sub-Stream / Sub-Agent** | Ein produzierender Entwicklungs-Stream: eine eigene Top-Level-`query()`-Session (`role: "sub"`) mit eigener Branch `feat/<task>` in eigenem Worktree. *Schlägt vor* (PR), merged **nie** selbst. NICHT zu verwechseln mit dem SDK-internen „Helper-Subagent" (`Agent`-Tool, gleiche Session). |
| **Helper-Subagent** | SDK-interner Subagent (über das `Agent`-Tool), läuft *innerhalb* einer Session, committet nicht, gibt ein Resultat zurück (z. B. `security-reviewer`). Kann **kein** `AskUserQuestion` nutzen — deshalb sind die parallelen Streams **keine** Helper-Subagents, sondern eigene Sessions. |
| **Worktree** | Zweites Arbeitsverzeichnis mit eigenem `HEAD`/Index/Working-Tree, aber geteiltem Objekt-Store/Refs. Ein Worktree pro Sub-Stream = die mechanische Isolation (kein `index.lock`-Kampf, kein `git add -A`-Übergriff). Ablageort (OE-1 entschieden): `~/mads-worktrees/<repo-slug>/<agentId>`, außerhalb des Repos. |
| **Stream** | Synonym für einen parallelen Entwicklungs-Arbeitsstrom = ein Agent + sein Worktree + seine Branch. Im UI „Stream"; im Datenmodell `Agent`. |
| **Eskalation** | Persistenter Zustand „Agent/Item braucht Hilfe", der sichtbar bleibt, bis er behandelt ist (CI rot, Merge-Konflikt, stale base, push rejected, Protection-Block, gh-Auth kaputt, Spawn-Crash, Budget, **Ownership-Trespass**). Quelle: GraphQL-Signale + lokaler git-Exit + `SidecarErrorMsg`. Abzugrenzen von der transienten „braucht Input"-Notification. |
| **Region-Ownership** | Ownership auf **Sub-Datei-Ebene** statt nur datei-grob (`Task.ownedFiles`): eine `OwnershipRule` ankert auf **Symbol/Pattern** (nicht Zeile — Zeilen driften) und gehört genau einem Stream (`kind`: `exclusive` \| `shared_seam` \| `land_first`). Kernregel: dieselbe Datei + verschiedene Symbole = erlaubt; fremdes Symbol/Pattern/ganze fremde Datei = Trespass. Logik: `detectTrespass` (`shared/ownership.ts`). Siehe [06](./06-ownership-and-coordination.md). |
| **Koordinations-Artefakt** (`CoordinationArtifact`) | Committetes, **transientes** Markdown-Dokument unter `docs/coordination/<name>.md`, das die teilnehmenden Streams, den `baseCommit` und die `OwnershipRule[]` hält. **Single-Writer = Integrator**; Sub-Agents lesen es. Nach Merge beider Streams `status: "resolved"` → löschen. Hebt das narrative paix-Koordinations-Doc auf eine maschinen-prüfbare Eigenschaft. Siehe [06](./06-ownership-and-coordination.md). |
| **Trespass-Gate** | Mechanische Prüfung (`detectTrespass(changes, rules, self)`), die aus `git diff` die geänderten Regionen extrahiert und gegen das Koordinations-Artefakt prüft. Timing: Sub-Agent **Pre-PR-Self-Check** + Integrator **periodisch** (Cron). Treffer → `EscalationKind: "ownership_trespass"` (Befund: Datei · Symbol · Owner-Stream); Auflösung via **Owner-Handoff** oder **land-first-PR**. Siehe [06](./06-ownership-and-coordination.md). |
| **stream-json** | Das strukturierte Event-Ausgabeformat von Claude Code / dem Agent SDK (typisierte `SDKMessage`-Events: `assistant_text`/`delta`, `tool_use`/`tool_result`, `thinking`, `system`, `result`). Quelle des Live-Terminals und der Status-/Kosten-Ableitung. Es gibt **keinen** nativen Fortschritts-Prozentwert. |
| **NDJSON (über stdio)** | Newline-delimited JSON: eine JSON-Nachricht pro Zeile (`\n`-terminiert) über das stdin/stdout des Sidecars. Transportiert alle Orchestrierungs-Nachrichten zwischen Rust-Core und Sidecar (`HostMessage`/`SidecarMessage`). stdout ist **nur** Protokoll, alle Logs gehen auf stderr. |
| **Channel** (Tauri) | `tauri::ipc::Channel<AgentOutput>` — geordneter High-Throughput-Kanal Core→Frontend für den Terminal-/Token-Stream (1 pro Agent). Gegenstück zu `emit`/`emit_to` für seltene, kleine Payloads. |
| **Sidecar** | Der eine langlaufende Node-Prozess, der den `AgentSession`-Pool, das Claude Agent SDK, Worktree-/GitHub-Operationen, die `IntegratorEngine` und den `UpdateMonitor`-Worker hostet. Aus dem Rust-Core gespawnt (`externalBin`), nicht aus dem Webview. |
| **`canUseTool`** | SDK-Callback, an dem riskante Tool-Aufrufe synchron pausieren, bis der Mensch entscheidet (allow/deny/`updatedInput`/`answer_questions`). Der zentrale „Mensch entscheidet"-Punkt; darf beliebig lange pending bleiben. Voraussetzung: Streaming-Input-Modus. |
| **Quality-Gate** | Deterministische Vor-PR-/Vor-Merge-Prüfkette: frozen install (`npm ci`/`pnpm --frozen-lockfile`, `cargo --locked`) → lint → type-check → test → security-review → CI-Rollup grün → review approved → `mergeStateStatus ∈ {CLEAN, HAS_HOOKS}`. |
| **Vor-Merge-Gate** | Die harte, beweisbare Bedingung, unter der `[Merge]` aktiv wird: `ciRollup==SUCCESS ∧ behindBy==0 ∧ mergeStateStatus∈{CLEAN,HAS_HOOKS} ∧ reviewDecision==APPROVED ∧ secretScanClean ∧ lockfileFrozenOk ∧ keine Blocker-Findings`. |
| **stale base / `BEHIND`** | Eine Branch, deren Merge-Basis hinter `origin/main` zurückliegt (`behind > 0` / `mergeStateStatus==BEHIND`). Der dokumentierte Hauptfehler-Fall; Gegenmittel ist der periodische `sync` (rebase onto fresh main). |

---

## Offene Entscheidungen (konsolidiert)

Diese Liste fasst die in den fünf Docs markierten **OFFENE-FRAGE-/OFFENE-ENTSCHEIDUNG**-Punkte
zusammen und ergänzt die im Review gefundenen **Cross-Doc-Widersprüche** (mit ⚠️ markiert).
Sie sind vor bzw. zu Beginn der Implementierung zu klären.

### Architektur-/Querschnitt (mehrere Docs betroffen)

- **OE-1 ✅ ENTSCHIEDEN — Worktree-Ablageort:** Verbindlich ist `~/mads-worktrees/<repo-slug>/<agentId>`
  (paix-konform, **außerhalb** des Repos, außerhalb der Working-Tree-Suche). `<repo>/.mads/` enthält nur
  Laufzeit-Metadaten (`agents.json`), **keine** Worktrees; `.mads/` bleibt im `.gitignore`. In allen Docs
  vereinheitlicht (Doc 01 §3.2, Doc 02 §3.1, Doc 04 §2.3/§3.2/§8.3).
- **OE-2 ✅ ENTSCHIEDEN — Single Source of Truth für Agenten-State:** Sidecar-Pool (in-memory) =
  Laufzeit-Wahrheit, `agents.json` = Resume-Wahrheit, SQLite (Core) = Audit/Historie. Der Rust-Core
  **spiegelt** den vom Sidecar gemeldeten State (Sidecar-Pool autoritativ), ist **nicht** autoritativ. Die
  Update-DB (Doc 05) gehört dem Core (ein Writer). Doc 02 §3.1 entsprechend korrigiert.
- **OE-3 ✅ ENTSCHIEDEN — Fenster-Modell:** MVP = **ein Hauptfenster** mit N xterm-Panes/Tabs; „Detach in
  eigenes Fenster" ist eine spätere optionale Aktion (**Post-MVP**). Doc 02/§9.1 und Doc 04 §7 entsprechend
  als Post-MVP markiert. Channel-Routing geht im MVP ins Hauptfenster.
- **OE-4 ✅ ENTSCHIEDEN — IPC-Routing (Detach):** Im MVP (ein Hauptfenster) landet der `Channel`-Output dort;
  das Detail-Routing samt zusätzlichem `emit_to(label,…)` ist erst bei der Post-MVP-Detach-Aktion relevant.
  (Doc 01 §2.3, Doc 04 §7.3)
- **OE-5 ✅ ENTSCHIEDEN — Event-Topologie:** Token/Terminal-Stream über `tauri::ipc::Channel<AgentOutput>`
  (1 pro Agent); Status als **im Core koalesziertes Delta-Event** (~30–60 ms); **separater High-Priority-
  Kanal** für „braucht Input"/„Eskalation" (nicht koalesziert). (Doc 01 §2.3/§6, Doc 02 §8)
- **OE-5a ✅ ENTSCHIEDEN — Kanonisches Status-Enum:** `starting | running | waiting_input | paused |
  escalation | error | done | queued` (überall identisch; `waiting_input` = transiente Rückfrage/Permission,
  `escalation` = persistenter Hilfe-Zustand). Abweichende Status-Namen (z. B. die UI-Projektion
  `AgentLifecycle` mit `idle`/`merging` in Doc 02 §3.1) werden per expliziter Mapping-Notiz auf dieses Enum
  abgebildet. (Doc 01 §5.1, Doc 02 §3.1, Doc 04 §2.1)
- **OE-6 Anthropic-Auth-Lizenz.** Subscription-OAuth für ein lokales Tool vs. API-Key-Pflicht für „angebotene
  Produkte" — vor Release juristisch klären. (Doc 01 §7.3, Doc 04 §8.2, Doc 05 §10)
- **OE-7 Sidecar-Bundling.** Nimmt `@yao-pkg/pkg` das gebündelte `claude`-Binary + native Module mit, oder
  müssen Node-Runtime + Binary daneben gebündelt werden? Früh in signierter CI testen. (Doc 01 §9.2, Doc 05 §6.4)

### Dashboard (Doc 02)

- **OE-8 Live-Terminal-Position.** Unten angedockt + höhenverstellbar (Empfehlung) vs. Inspector-Tab? (§2)
- **OE-9 Fortschritts-Heuristik.** Nur Plan-Schritte für Determinate (robust) vs. zusätzlich brüchiges
  Test-Counter-Parsing? Scope festlegen. (§3.3)
- **OE-10 Risk-Hint-Klassifikation.** Eigene lokale Pattern-Tabelle für destruktive Bash-Cmds vs. nur
  SDK-Signale (`blockedPath`/`decisionReason`)? Nie auto-deny. (§4.1)
- **OE-11 Terminal-Persistenz-Tiefe.** Frontend-only vs. Core-Ring-Buffer (Empfehlung) vs.
  On-Disk-Transcript-Replay? (§6)
- **OE-12 Eskalations-Spalte als Default-View?** Kanban-Modus (`Needs input | Escalation | Running | Done`)
  als Default oder optionaler Toggle? (§5.2)

### Main-Agent / Integrator (Doc 03)

- **OE-13 Mechanik-Hoheit des LLM.** Darf der `MAIN_AGENT` eigene `git rebase`/`git merge`-Mechanik fahren,
  oder strikt nur Konflikt-Hunks editieren (Engine fährt git, verifiziert via CI)? (A1)
- **OE-14 Schreibrecht auf Koordinations-Artefakte.** Nur der Integrator in Append-Dateien (`BACKLOG.md`,
  ADR-Index, `OWNERSHIP_MAP`), oder dürfen Sub-Agents direkt anhängen? (Empfehlung: Single-Owner.) (B1)
- **OE-15 Schwellen/Intervalle.** Konkrete Werte für `STALE_THRESHOLD`, Rebase-Reminder-Frequenz,
  „main heiß"-Heuristik und Cron-Intervalle — empirisch zu kalibrieren. (C1)
- **OE-16 Integrator-Self-Approval** *(offen; Default gesetzt)*. Darf der Integrator selbst
  `reviewDecision=APPROVED` setzen (Solo-Maintainer), oder muss immer ein *menschliches* Approval vorliegen?
  **Default: menschliches Approval erforderlich** (konfigurierbar). Endgültige Policy offen. (C2)
- **OE-17 Merge-Queue-Übergang.** Ab welchem racing-PR-Druck von manueller Serialisierung auf die native
  GitHub-Merge-Queue umschalten, und automatisiert mads deren (REST-seitig unklare) Aktivierung? (C3)
- **OE-18 Modellwahl/`effort` Integrator.** Bleiben Klassifikations-Calls auf `claude-opus-4-8`, oder
  Downgrade auf `sonnet` zur Kostenkontrolle bei vielen parallelen Konflikten? (C4)

### Sub-Agents (Doc 04)

- **OE-19 Permission-Timeout-Policy** *(offen; Default gesetzt)*. **Default: sichtbar blockiert
  (unbegrenzt), kein Auto-Allow**; optionaler Soft-Timeout → `defer` (per Default aus). Konkrete Schwelle N
  bei aktiviertem Soft-Timeout bleibt zu kalibrieren. (Doc 04 §4.4)
- **OE-20 Globale Permission-Defaults vs. „remember".** „Remember"-Häkchen pro Tool/Pattern — session-scoped
  oder persistent in `.claude/settings.local.json` pro Worktree? (§4.4)
- **OE-21 `bypassPermissions` für CI-artige Hintergrund-Streams.** Opt-in-Profil für rein mechanische,
  vorab freigegebene Aufgaben — mit welchen harten Leitplanken? (§8.3)
- **OE-22 ✅ ENTSCHIEDEN — Granularität von `ownedFiles`.** Statt fester Datei-Liste im Prompt:
  **Region-Ownership** via `OwnershipRule`/`CoordinationArtifact` + `detectTrespass` (Symbol-/Pattern-Anker,
  zur Laufzeit aus dem committeten Artefakt gelesen, robuster gegen Drift). Siehe
  [06](./06-ownership-and-coordination.md); Typen in `shared/protocol.ts`/`shared/ownership.ts` vorhanden,
  Behavior ab Roadmap P3/P4. (Doc 04 §6.4/§10)

### Update-Bereich (Doc 05)

- **OE-23 Quellen-Erweiterung.** `docs.claude.com`-Release-Notes per HTML-Hash-Diff zusätzlich pollen?
  (Vorschlag: nein.) (§2.1)
- **OE-24 Issue-Modus.** Default `per-version` (A) vs. `rolling` (B)? (Vorschlag: A für breaking/feature,
  B für Bugfix-Bündel — Hybrid.) (§5.1)
- **OE-25 Self-Update-Artefakte.** Universal-`.app` (ein darwin-Eintrag) vs. getrennte
  `darwin-aarch64`/`darwin-x86_64`-Artefakte? (§6.2)
- **OE-26 Upgrade-Job-Hosting.** In-app-Scheduler vs. GitHub-Action-Cron für den getesteten SDK/Binary-Bump-PR?
  (Vorschlag: GitHub-Action als Default, in-app als Komfort.) (§7.3)
- **OE-27 ✅ ENTSCHIEDEN — Persistenz-Ownership der Update-DB:** Der **Rust-Core besitzt die Update-DB**
  als **einziger Writer** (via `update.*`-NDJSON-Commands); kohärent mit OE-2. (Doc 05 §2.3/§9.1)
- **OE-28 Doppel-Issue-Race.** Lokales Advisory-Lock nötig, oder reicht der Duplikat-Check für Single-User? (§5.3)
- **OE-29 Auto-Create-Policy** *(offen; Default gesetzt)*. **Default: Human-in-the-Loop, kein Auto-Create**
  (`autoCreateIssues` = off). Ob es jemals Default-on sein darf, bleibt offen. (Doc 05 §3.3/§8.4)
- **OE-30 ✅ ENTSCHIEDEN — GitHub-Repo-Identität:** Ziel-Repo ist **nicht** hartkodiert, sondern der
  konfigurierbare `project.remote = { owner, repo }` ([[01-architecture]] §5.1). Für die mads-eigene Instanz
  ist dieser Wert per Default-Konfiguration auf `Hobbesch/mads` gesetzt (Beispiel/Default, keine Konstante im
  Code). Doc 05 §0/§5 entsprechend angepasst.

---

## Lese-Reihenfolge (Empfehlung)

1. **01 Architektur** (Dach: Schichten, Invarianten, Datenmodell, IPC).
2. **04 Sub-Agents** und **03 Main-Agent** (die zwei Rollen des Integrator-Modells).
3. **06 Region-Ownership & Koordination** (wie die beiden Rollen Konflikte *vor* dem Merge vermeiden).
4. **02 Dashboard** (die UI über dem Event-Bus).
5. **05 Update-Bereich** (das Querschnitts-Beobachter-Subsystem).
