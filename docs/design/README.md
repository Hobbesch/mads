# mads — Design-Dokumentation (Index)

> **Status:** Design, implementierungsreif. Stand: 2026-06-22.
> **Sprache:** Deutsch (Fließtext), Englisch (Code/Identifier).
> Dieser Index bündelt die zehn Design-Dokumente von **mads**, erklärt die zentralen
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

## Die Design-Dokumente

| # | Dokument | In einem Satz |
|---|---|---|
| 01 | [Gesamtarchitektur](./01-architecture.md) | Schichtenmodell, Prozess-/Concurrency-Topologie, Datenmodell, IPC-Protokolle, Sicherheit, Tech-Stack und Roadmap — das Dach, auf das alle anderen Docs aufbauen. |
| 02 | [Dashboard](./02-dashboard.md) | Die zentrale Übersichts- und Steuer-Oberfläche (Activity-Rail + Agent-Grid + Inspector — **keine** persistente Sidebar mehr —, Live-Terminal, Inbox, Eskalations- und Integrator-Panels) als reine Anzeige-/Steuer-Schicht über dem Event-Bus. |
| 03 | [Main-Agent (Integrator)](./03-main-agent.md) | Der Integrator als Hybrid aus deterministischer `IntegratorEngine` (Guards, Merge-Mechanik) und LLM-`query()`-Session (Urteilsfragen), inkl. Merge-Prozedur, Gates, Cron-Jobs und Eskalation. |
| 04 | [Sub-Agents](./04-sub-agents.md) | Der produzierende Entwicklungs-Stream: eine `query()`-Session pro Worktree/Branch, Lebenszyklus-Zustandsmaschine, Rückfrage-Protokoll, GitHub-Interaktion, Detailansicht (xterm-Pane; Detach Post-MVP), Permissions und Crash-Recovery. |
| 05 | [Update-Bereich](./05-update-area.md) | Read-mostly-Beobachter, der neue Claude-Code-/SDK-Fähigkeiten erkennt, LLM-bewertet und als GitHub-Issue vorschlägt; plus mads-Self-Update und Versions-Pinning. |
| 06 | [Region-Ownership & Koordination](./06-ownership-and-coordination.md) | Ownership auf Sub-Datei-Ebene (`OwnershipRule`/`CoordinationArtifact`) mit mechanischem Trespass-Gate (`detectTrespass` → `ownership_trespass`), das fremde Region-Edits *vor* dem Merge als Eskalation sichtbar macht. |
| 07 | [Datei-Explorer & In-App-Editor](./07-file-explorer.md) | Lazy-/virtualisierter Verzeichnisbaum (`react-arborist`) + Content-Bereich (Vorschau/Edit) über einen **wählbaren Stream-Kontext** — `main`/Integrator **oder** ein Sub-Agent-Worktree, beide les- **und schreibbar** (OE-35); erste Funktion mit direktem Datei-Zugriff — der **Schicht-Test**: aller FS-I/O läuft durch den Rust-Core (`mads_read_dir`/`mads_read_file`/`mads_write_file`, capability-gescoped, mtime+hash-Conflict), nie aus dem Webview. |
| 08 | [Markdown-Editor](./08-markdown-editor.md) | In-App-Lese-/Schreiboberfläche für `.md` (Design-Docs, README, Koordinations-Artefakte): GitHub-Style-Render (`react-markdown`-Pipeline) + CodeMirror-6-Quell-Editor (Preview/Edit/Split), Bild-Paste, Wikilink-Auflösung — alles FS-Zugriff über die Core-Commands aus [[07-file-explorer]]. |
| 09 | [Change-Overview](./09-change-overview.md) | Toggle-bare Live-Diff-Panes: öffnet für jede gerade editierte Datei automatisch eine `@codemirror/merge`-Pane (Additions grün, Löschungen rot), rein aus dem `tool_use`-Payload derivierbar (zero-read, `editsByFile`-Slice); Kollisions-/Trespass-Overlay aus [[06-ownership-and-coordination]]. |
| 10 | [Navigations-Toolbar](./10-navigation-toolbar.md) | Die äußerste Activity-Rail links als einziger Umschalter des aktivitäts-spezifischen Primary-Panels (`activeView`/`ToolbarItem`-Registry); **löst die persistente Stream-Sidebar auf** (das `AgentGrid` ist die Stream-Liste) und definiert den verbindlichen LAYOUT-CONTRACT für 02/07/09; reine UI-Zustands-Auswahl ohne Backend-Bedarf. |
| 11 | [Härtung: Lehren aus dem Parallel-Betrieb](./11-hardening-lessons.md) | Post-Mortem eines realen Betriebstags mit parallelen Sub-Agenten auf einem Kundenrepo: zehn Vorfälle, auf sieben Fehlerklassen abstrahiert, gegen den nativen Fähigkeitsstand von Claude Code gestellt und in eine priorisierte Härtungs-Roadmap überführt. |
| 12 | [Projekt-Verbund](./12-project-link.md) | Zwei fachlich gekoppelte Repos in je eigener mads-Instanz koordinieren sich über einen deklarierten **Contract**, einen Maildir-**Peer-Kanal** und ein mechanisches **Drift-Gate**; die Gegenseite zieht als gewöhnlicher Sub-Stream nach, gemergt wird weiterhin nur pro Repo vom Integrator. |

**Recherche-Inputs** (normative bzw. technische Quellen, referenziert von allen Docs):

- [_paix-multi-agent-reference_](../research/_paix-multi-agent-reference.md) — normative Multi-Agent-Invarianten und Worktree-/Integrations-Disziplin.
- [claude-code-capabilities](../research/claude-code-capabilities.md) — Agent SDK, `canUseTool`, Hooks, Permission-Modes, Modelle, Auth.
- [sidecar-orchestration](../research/sidecar-orchestration.md) — Sidecar-Pool, NDJSON-Protokoll, State-Maschine, Backpressure, Crash-Recovery.
- [github-multiagent](../research/github-multiagent.md) — gh/Octokit, Eskalations-Signale, Branch-Protection, Merge-Queue, Auth.
- [tauri2-stack](../research/tauri2-stack.md) — Channels vs. Events, Multi-Window, Plugins, Signing/Notarization, Updater.
- [macos-design](../research/macos-design.md) — HIG, Sidebar/Content/Inspector, Vibrancy, Update-Monitoring.

> **Verlinkung:** Die Docs verweisen untereinander mit `[[wikilink]]`s auf die tatsächlichen
> Dateinamen — Design-Docs als `[[01-architecture]]`…`[[06-ownership-and-coordination]]` sowie
> `[[07-file-explorer]]`, `[[08-markdown-editor]]`, `[[09-change-overview]]`,
> `[[10-navigation-toolbar]]`, `[[11-hardening-lessons]]`, `[[12-project-link]]`; Recherche-Inputs als
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
| **Markdown-Editor** (`MarkdownEditor`) | Die In-App-`.md`-Lese-/Schreiboberfläche (`src/components/MarkdownEditor.tsx`), `.md`-Spezialfall des generischen Editors aus [[07-file-explorer]]. Drei **View-Modi** (`ViewMode = "preview" \| "edit" \| "split"`, global `editorViewMode`, eine Datei zur Zeit offen): **Preview** (GitHub-Style-Render), **Edit** (CodeMirror-6-Quelle), **Split** (beide + Scroll-Sync). Schreibt nur Working-Trees, nie Commits/PRs (Speichern ≠ committen). Siehe [08](./08-markdown-editor.md). |
| **`editorBuffers`** | Zustand-Store-Slice `Record<path, string>`: die ungesicherte Working-Copy einer offenen Datei **vor** dem Save — reiner UI-Mirror, **nicht** die SSOT über den Disk-Inhalt (die bleibt Core/git-Working-Tree). Pro Pfad gekeyt, überlebt den Datei-/View-Wechsel (wie `drafts`); `dirty` ⇔ Buffer ≠ zuletzt geladener Disk-Stand. Save geht über das Core-Command `mads_write_file` (07 §4.2), mtime-Conflict server-seitig. Siehe [08](./08-markdown-editor.md) §3. |
| **`mdPipeline`** (`src/mdPipeline.ts`) | Single-Source der remark-/rehype-Plugin-Arrays + Sanitize-Schema + Wikilink-Plugin der Markdown-Render-Pipeline (`react-markdown` + `remark-gfm` + `rehype-starry-night` + `rehype-sanitize` + `github-markdown-css`). Von `MarkdownPreview` **und** dem konsolidierten `Md` in `MessageTimeline.tsx` importiert, damit Chat- und Editor-Render identisch und gleich sicher sind. Siehe [08](./08-markdown-editor.md) §2/§5. |
| **Change-Overview** (`ChangeOverlay`) | Toggle-bare, datei-zentrierte **Live-Diff-Sicht**: bei aktivem `changeOverviewOn` öffnet für jede gerade editierte Datei automatisch eine Diff-Pane (`@codemirror/merge`), zweiter Toggle schließt alle trivial. **Kein Primary-Panel**, sondern ein `position:fixed`-**Overlay über `.app`** (letztes Kind, gesteuert von `changeOverviewOn`, **nicht** `activeView`, OE-41) — koexistiert mit jeder View, belegt keine Mittel-Spalte; der Rail-Eintrag „Änderungen" ist ein Aktions-Toggle (⇧⌘D). **Read-only** (keine push/commit/merge-Aktion), rein aus dem `tool_use`-Payload derivierbar (`shared/protocol.ts` §218). Die **räumliche** Ergänzung zur chronologischen `MessageTimeline` ([[02-dashboard]] §6). NICHT zu verwechseln mit dem committeten git-Diff des `collisionPass`. Siehe [09](./09-change-overview.md). |
| **DiffPane** (`PaneVM`) | Eine **Pane = ein Stream × eine Datei** der Change-Overview (Key `${agentId}::${path}`, View-Projektion eines `editsByFile`-Eintrags). Trägt Stream-Farbe (`StatusDot`) + Label + Pfad, das Kollisions-/Trespass-Overlay (06) als Rahmen, und die `ops[]`→Sub-View-Reduktion (`MergeDiffView` rendert je **ein** old/new-Paar). Zwei Streams an derselben Datei = **zwei** Panes (macht die Kollision räumlich sichtbar). Siehe [09](./09-change-overview.md) §2. |
| **`editsByFile`** | Zustand-Store-Slice `Record<string, FileEditEntry>` (Key `${agentId}::${path}`), den die Change-Overview neu einführt: hält den **verbatim `tool_use`-Input** der vier Edit-Tools (`Edit`/`MultiEdit`/`Write`/`NotebookEdit` → `ops: EditOp[]`), den der bestehende Store heute verwirft. Rein UI-derived (kein Protokoll-/Rust-Change). `stopAgent` muss die `${id}::`-Keys mit aufräumen. Siehe [09](./09-change-overview.md) §3. |
| **Datei-Explorer** (`FileExplorer`) | Das `activeView==="files"`-Primary-Panel (`src/components/FileExplorer.tsx`, mit `StreamContextSwitcher`/`FileTree`/`FilePreview`/`FileEditor`): lazy-/virtualisierter (`react-arborist`) Verzeichnisbaum über den **gewählten Stream-Kontext** (`main`/Integrator **oder** ein Sub-Agent-Worktree) + Content-Bereich (Vorschau/Edit je Dateityp). **Read-mostly mit gegated Edit, auch in Sub-Agent-Worktrees** (OE-35 entschieden); aller Disk-Zugriff läuft durch den Core, nie aus dem Webview. Mountet als **eigene Mittel-Spalte** (Primary-Panel-Slot, im Streams-View leer) **zwischen** Activity-Rail und `.main`; `.center` (`AgentGrid`) + `<Inspector/>` **bleiben unverändert** sichtbar (LAYOUT-CONTRACT (a)/(f)) — es gibt **keine** persistente Sidebar mehr. Siehe [07](./07-file-explorer.md). |
| **`ExplorerRoot`** | Diskriminierter Store-Typ, *welcher* Stream-Kontext gebrowst wird: `{ kind:"project"; path }` (das `repoRoot`/`main`-Checkout, Default) oder `{ kind:"worktree"; agentId; path }` (`~/mads-worktrees/<slug>/<agentId>`, Sub-Agent-Worktree). **Beide Varianten sind gleichwertig lesbar UND schreibbar** (beide via `mads_register_root` → `allow_directory` registriert, OE-35 entschieden). Editieren **im** gewählten Worktree ist der Normalfall (informative Leiste „Stream X · noch nicht auf `main`"), **kein** Trespass; die Koordinations-**Warnung** feuert nur bei einer Region, die ein **anderer** Stream besitzt. Siehe [07](./07-file-explorer.md) §3.1/§5.3. |
| **Stream-Kontext-Selector** (`StreamContextSwitcher`) | Der **immer sichtbare** Panel-Header des Datei-Explorers (`src/components/StreamContextSwitcher.tsx`): listet `main`/Integrator (`project.repoRoot`) **+ jeden aktiven Sub-Agent** (`order.map(id => agents[id])`, je Eintrag `StatusDot` aus `STATUS_META[agent.status]` + `label`) und setzt per `setActiveRoot(...)` den `ExplorerRoot`. Beantwortet „wessen Dateien sehe ich gerade an?". Weil die persistente Sidebar aufgelöst ist (OE-52), bringt der Explorer **seinen eigenen** Selektor mit (LAYOUT-CONTRACT (c)) — **dieselbe** Stream-Identität/-Farbe, mit der [[09-change-overview]] seine Panes (`${agentId}::${path}`) gruppiert. Siehe [07](./07-file-explorer.md) §1.2/§1.3, [10](./10-navigation-toolbar.md) LAYOUT-CONTRACT. |
| **Aufgelöste Stream-Sidebar** (ex-`Sidebar.tsx`) | Die frühere persistente Mittel-Sidebar mit der Stream-Liste ist **entfernt** (OE-52 ✅): ihre Stream-Liste war eine ärmere Teilmenge des `AgentGrid` (redundant, Anti-Pattern ggü. VS-Code-/Xcode-/HIG-Sidebar-Mustern). Ersatz: das `AgentGrid` **ist** die Stream-Liste; Unikat-Elemente wandern in die Activity-Rail / `RecentProjectsPopover` / Titlebar / Statusleiste; die „Erledigt"-Gruppe wird kollabierte Grid-Sektion. Off-Dashboard-Awareness über Rail-Badge auf „Streams" + Notification + `⌘1`-Rücksprung. Siehe [10](./10-navigation-toolbar.md) §1a, [02](./02-dashboard.md) §2. |
| **`OpenFile` / `FileRead`** | Das Lese-Resultat des Cores: **der Core** (nicht der Webview) entscheidet text-vs-binary per UTF-8-Decode-Versuch — `FileRead::Text { text }` bei Erfolg, `FileRead::Binary { bytes_base64 }` sonst (jeweils mit `mtime_ms`, `size`, `truncated`). `OpenFile` ist die Store-Projektion davon (`kind`, `loadedText`/`bytesBase64`, Disk-Signatur fürs Conflict-Signal). Der Webview bekommt nie rohe Bytes zum Dekodieren. Siehe [07](./07-file-explorer.md) §3.1/§4.2. |
| **`FsScope` / `ensure_in_scope`** | Der **autoritative Laufzeit-Gate** im Core (`src-tauri/src/files.rs`): jeder vom Webview angefragte Pfad wird `canonicalize()`d und muss Prefix-Nachfahre des registrierten `repoRoot` **oder** eines `~/mads-worktrees/<slug>/<agentId>` sein — sonst Reject. Schlägt Symlink-Escape und `..`-Traversal, die der literale Capability-Glob (`fs.json`) allein nicht abdeckt. `FsScope` ist die mads-eigene Laufzeit-Allow-Liste (gefüllt via `mads_register_root` nach Projektwahl). Siehe [07](./07-file-explorer.md) §5.1. |
| **`mads_read_dir` / `mads_read_file` / `mads_write_file` (/`_bytes`) / `mads_register_root`** | Die **mads-eigenen `#[tauri::command]`s** (Core, `files.rs`), über die *aller* FS-Zugriff läuft — **nicht** über den Sidecar/NDJSON (dessen stdout ist NDJSON-only, OE-31) und für Read/Write/Walk **nicht** über die `tauri-plugin-fs`-Built-ins (nur `watch` nutzt das Plugin, OE-32). `mads_write_file` macht den Conflict-Check (mtime+size+content-hash) **server-seitig** (kein silent clobber); `mads_write_file_bytes` ergänzt Doc 08 für die Bild-Paste. `mads_register_root` erweitert den fs-Scope auf den zur Build-Zeit unbekannten `repoRoot`. Geteilt von Explorer, Markdown-Editor und (lesend) Change-Overview. Siehe [07](./07-file-explorer.md) §4. |
| **Activity-Rail / Navigations-Toolbar** (`ActivityRail`) | Die äußerste Leiste links (`src/components/ActivityRail.tsx`, `.activity-rail`); benutzerseitig „Navigations-Toolbar", Code-Identifier `ActivityRail`. **Ersetzt** die aufgelöste Stream-`Sidebar` (deren Stream-Liste war redundant mit dem `AgentGrid`, OE-52) und absorbiert deren Unikat-Elemente (Recent/Projekt, Neuer-Stream, Brand/About). Einziger Umschalter des **Primary-Panels** via `activeView`; der „Änderungen"-Eintrag ist ein **Aktions-Toggle** (`changeOverviewOn`), kein Panel-Switch. Reine UI-Zustands-Auswahl, **kein** Backend-/Merge-/git-Bezug. Aufgeklappt Icon+Label, kollabiert nur Icon (`railCollapsed`). Siehe [10](./10-navigation-toolbar.md). |
| **Primary-Panel** (`PrimaryPanel`) | Der **aktivitäts-spezifische** Mittel-Slot (`src/components/PrimaryPanel.tsx`) zwischen Activity-Rail und Content (`.main`): `activeView==="files"` → File-Explorer ([[07-file-explorer]]), `"settings"` → Settings-Panel; `activeView==="streams"` (Default) rendert **`null`** (kein Mittel-Panel — das `AgentGrid` ist die Stream-Liste, die alte Sidebar ist aufgelöst, OE-52). **Kein** persistenter Mittel-Streifen; erscheint nur bei aktivitäts-spezifischen Views. `.main` (AgentGrid + Inspector) bleibt **immer** sichtbar. Die Change-Overview ist **kein** Primary-Panel, sondern ein Overlay (siehe `Change-Overview`-Eintrag). Layout: `activity-rail \| primary-panel (ggf. leer) \| main`. Siehe [10](./10-navigation-toolbar.md) LAYOUT-CONTRACT. |
| **ToolbarItem-Registry** (`TOOLBAR_ITEMS`, `src/toolbarItems.ts`) | Deklarative SSOT der Rail-Einträge (`ToolbarItem[]`): `id`, `icon`, `label`, `order`, `kind` (`panel` \| `action` \| `popover`), optional `view`/`enabled(s)`/`badge(s)`/`shortcut`. Neue Features hängen **eine Zeile** an, ohne `ActivityRail` zu ändern. Typ-Importe (`MadsState`, `LucideIcon`) sind `import type` (kein Import-Cycle, kein Icon-Dep im reinen Logik-Pfad). Siehe [10](./10-navigation-toolbar.md) §3.2. |
| **`activeView`** (`ViewId`) | Zustand-Store-Feld + `ViewId`-Union (`"streams" \| "files" \| "settings"`, erweiterbar): welches Primary-Panel sichtbar ist (`"streams"` = keines). **`"changes"` ist KEIN `ViewId`** — die Change-Overview ist ein Overlay (`changeOverviewOn`), kein Panel-View. **localStorage-persistiert** (`src/uiPrefs.ts`, Stil von `src/recent.ts`), **nicht** über NDJSON/`agents.json`/SQLite — reine app-weite UI-Vorliebe, kein Agenten-State (Invariante 5 unberührt). Ungültiger persistierter Wert → Fallback `"streams"`. Siehe [10](./10-navigation-toolbar.md) §3.1. |

---

## Offene Entscheidungen (konsolidiert)

Diese Liste fasst die in den Docs markierten **OFFENE-FRAGE-/OFFENE-ENTSCHEIDUNG**-Punkte
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

### Datei-Explorer / Editor (Doc 07)

- **OE-31 ✅ ENTSCHIEDEN — FS-Transport:** Datei-I/O läuft **durch den Rust-Core** (`tauri-plugin-fs`
  + mads-eigene `#[tauri::command]`s), **nicht** über den Sidecar/NDJSON (dessen stdout ist
  NDJSON-only; FS ist dieselbe Trust-Klasse wie Prozesse/Secrets). Ein auditierbarer Chokepoint im
  Core; `shared/protocol.ts` bleibt für den FS-Kern unverändert (nur ein optionaler
  `fs:external_change`-Tauri-Event). (Doc 07 §4.1)
- **OE-32 ✅ ENTSCHIEDEN — Command-Aufteilung:** Read/Write/Dir-Walk = **mads-eigene Commands**
  (`std::fs` + `ignore`-Crate, mads-Policy im Core); der **`tauri-plugin-fs`-`watch`/`watchImmediate`**
  wird nur für den Live-Reload genutzt. So bleibt der Webview vollständig von der Platte getrennt.
  (Doc 07 §4.2)
- **OE-33 Trespass-Härte (fremde Region)** *(offen; Default gesetzt)*. Edits **in jedem gewählten
  Stream-Kontext** (`repoRoot` wie Sub-Agent-Worktree) sind erlaubt (OE-35). Offen bleibt **nur**:
  Soll mads beim **genuinen Region-Trespass** — Editieren einer Datei, die ein **anderer** Stream
  besitzt (§5.3) — nur **warnen** (rote Leiste) oder den Save **hart sperren**? **Default: erlauben +
  warnen** — der Mensch bleibt souverän; harte Sperre wäre paix-konformer, aber bevormundend.
  **Abgrenzung:** betrifft **nicht** den eigenen Worktree-Kontext (der ist informativ, OE-35), nur
  fremde-Region-Overlaps. Review legt fest. (Doc 07 §5.3/§11)
- **OE-34 Read-Cap-Größe.** Konkrete Schwellen für Datei-/Verzeichnis-/Bild-Caps (Vorschlag: **2 MB
  Text, 2000 Einträge, 5 MB Bild**) — empirisch zu kalibrieren; bei Überschreitung **immer**
  sichtbarer Hinweis + Opt-in-Vollload bzw. Binär-Fallback, nie still abschneiden (konsistent mit
  OE-40 in 08). (Doc 07 §6/§11)
- **OE-35 ✅ ENTSCHIEDEN — Worktree-Browsing & -Editieren:** Das **Browsen UND Editieren eines
  Sub-Agent-Worktrees ist ein First-Class-Flow**, **nicht** read-only. Ein per Stream-Kontext-Selector
  gewählter Worktree wird im Core **identisch zu `repoRoot`** registriert (`mads_register_root` →
  `allow_directory`) und ist damit lesbar **und schreibbar**. Begründet durch den Kern-Use-Case: ein
  Sub-Agent schreibt eine `.md`, die **noch nicht auf `main`** ist — der Mensch muss sie **im Worktree
  dieses Streams** reviewen, editieren und speichern können ([[08-markdown-editor]]), bevor der reguläre
  PR/Merge-Weg ([[03-main-agent]]) sie nach `main` bringt. Leitplanke ist **Awareness** statt read-first:
  eine **informative** Worktree-Leiste („Stream X · noch nicht auf `main`", kein Blocker), die echte
  Trespass-Warnung nur bei **fremder** Region (OE-33), und der nebenläufige-Agent-Write-Caveat
  (Stream pausieren oder im Leerlauf editieren; `watchImmediate` + mtime/hash-Conflict-Check schützen).
  Speichern ist ein lokaler Disk-Write, **kein** Commit/PR/Merge — Invarianten 1–3 gewahrt.
  (Doc 07 §0/§1.2/§5.3/§10/§11)

### Markdown-Editor (Doc 08)

- **OE-36 ✅ ENTSCHIEDEN — Default-View:** `.md`-Dateien öffnen im **Preview**-Modus (leserlich zuerst,
  GitHub-Analogie); Edit/Split sind ein Klick (`⌘⏎`) entfernt. Der zuletzt gewählte Modus wird **session-only**
  gemerkt (`editorViewMode`, global — es ist genau eine `.md` zugleich offen, OE-38), **nicht** persistiert
  (OE-3: kein Settings-Store). (Doc 08 §1.1 / [[08-markdown-editor]] §1.1)
- **OE-37 Autosave** *(offen; Default gesetzt)*. **Default: aus** (explizites `⌘S`). Offen, ob Autosave
  (debounced 1500 ms) opt-in im MVP oder Post-MVP kommt — und ob das Save-Feedback eine **globale Toast-Notice**
  braucht (heute ist `notice` agent-gebunden). (Doc 08 §1.2/§3.3 / [[08-markdown-editor]] §11)
- **OE-38 Panel-Platzierung** *(offen; Default gesetzt)*. **Default: `.center`-Slot** (Inspector bleibt
  sichtbar, Layout aus [[02-dashboard]] §2 intakt) vs. breites `.body`-Panel (mehr Schreibfläche, Inspector
  verdeckt)? (Doc 08 §1.3 / [[08-markdown-editor]] §11)
- **OE-39 Bild-Paste-Zielverzeichnis.** Bilder nach `<dir>/assets/` relativ zur Datei (Vorschlag) vs. ein
  repo-weites `docs/assets/`/`.attachments/`? Und Namensschema (`<ts>-<n>` vs. Content-Hash zur Dedup)?
  (Doc 08 §1.2/§5.3 / [[08-markdown-editor]] §11)
- **OE-40 Größen-Cap.** Read-only-Schwelle bei **2 MB** (Vorschlag) — Wert zu kalibrieren; Cap muss geloggt +
  im UI sichtbar sein (nie stilles Truncate; konsistent mit OE-34 in 07). (Doc 08 §6 / [[08-markdown-editor]] §11)

### Change-Overview (Doc 09)

- **OE-41 ✅ ENTSCHIEDEN — In-App-Grid statt OS-Multi-Window:** Die „dutzende Fenster"-Anforderung wird als
  **In-App-Overlay-Grid virtualisierter Diff-Panes in einem Fenster** umgesetzt (Toggle schließt alle trivial;
  Fokus/Performance; OE-3-konform). „Detach in OS-Fenster" pro Pane ist **Post-MVP** (spiegelt [[02-dashboard]] §9.1).
  (Doc 09 §1.4 / [[09-change-overview]] §1.4)
- **OE-42 ✅ ENTSCHIEDEN — Diff-Renderer `@codemirror/merge`:** `unifiedMergeView` (inline) / `MergeView` (split)
  mit `goToNextChunk` für Auto-Scroll; konsistent mit der CodeMirror-6-Wahl für 07/08. Schließt die
  **Op→Dokument-Reduktion** ein: `MergeDiffView` rendert genau **ein** old/new-Paar, die `ops[]`→Sub-View-Abbildung
  lebt im `DiffPane`-Reducer `opsToSubViews` (eine Sub-View pro Hunk im zero-read-MVP; ein echtes Single-Paar mit
  `contextDoc`). (Doc 09 §2.3/§2.4 / [[09-change-overview]] §2)
- **OE-43 ✅ ENTSCHIEDEN — Kollisions-/Trespass-Overlay auf Panes:** Eine Pane, deren `path` in einem aktiven
  `Collision`/`TrespassFinding` auftaucht, bekommt einen hervorgehobenen Rahmen (rot bei `region`/Trespass, amber bei
  `file`/`land_first`) + Rivalen-Stream & Symbol; Join auf `path`, Logik aus `shared/` (SSOT mit `collisionPass`).
  (Doc 09 §5 / [[06-ownership-and-coordination]] / [[09-change-overview]] §5)
- **OE-44 Inaktivitäts-Auto-Close** *(offen; Default gesetzt)*. **Default: kein Auto-Close — nur der Toggle
  schließt.** Soll eine Pane nach `idleCloseMs` ohne Edit automatisch verschwinden? (Doc 09 §1.2 / [[09-change-overview]] §1.2)
- **OE-45 Pane-/File-Caps** *(offen; Default gesetzt)*. **Default: `maxVisiblePanes = 8`, `maxFiles = 200`.** Sinnvoll
  fix oder nutzer-konfigurierbar? Jede Deckelung wird sichtbar gemacht + in `debugLog` protokolliert (nie still).
  (Doc 09 §6 / [[09-change-overview]] §6)
- **OE-46 Live- vs. committeter Diff als Default.** Primär der **in-flight**-Hunk (Option A, zero-read) oder der
  **committete** Diff (Option B, Zeilennummern/Kontext)? (Vorschlag: in-flight als Default, committet als Header-Toggle.)
  (Doc 09 §4.1/§4.2 / [[09-change-overview]] §4)
- **OE-47 FS-Zugriff: first-party Command vs. Plugin-Bridge.** Geht der optionale Kontext-Read über ein first-party
  `mads_read_file` (mads-Policy am Chokepoint, spiegelt `sidecar.rs`) oder direkt über die `tauri-plugin-fs`-Command-
  Bridge? (Vorschlag: first-party für Reads, Plugin nur für `watch`.) Teilt sich Capability `mads-fs` + Command mit
  [[07-file-explorer]] — **keine** zweite `capabilities/fs.json`. (Doc 09 §4.3 / [[09-change-overview]] §4.3)
- **OE-48 Symbol-Quelle für den Kollisions-Join.** Symbole der **live**-Pane billig aus `new_string`/`content`
  (`extractSymbol`) oder erst aus dem committeten `parseDiffRegions`-Output (zuverlässiger, verzögert)? (Vorschlag: live
  aus dem Payload, beim Vorliegen des committeten Diffs überschreiben.) (Doc 09 §5 / [[09-change-overview]] §5)

### Navigations-Toolbar (Doc 10)

- **OE-49 Icon-Set für die Activity-Rail** *(offen; Default gesetzt)*. **Default: `lucide-react`**
  (tree-shaken, konsistentes 16–20 px-Set, React-19-kompatibel — der Web-Pkg ist nur durch eine
  konservativ formulierte Peer-Range „gewarnt"). `lucide-react` ist heute **nicht** in `package.json`;
  seine Einführung ist ein `package.json`/`package-lock.json`-Bump → Shared-File-/Lockfile-Protokoll
  (CLAUDE.md „Build & Gates"). Offen bleibt, ob `StatusDot`/Brand mittelfristig mit-migrieren.
  (Doc 10 §2.1 / [[10-navigation-toolbar]] §2.1, [[02-dashboard]] §3.2)
- **OE-50 Default-View beim App-Start** *(offen; Default gesetzt)*. **Default: persistierten
  `activeView` aus `mads.uiPrefs` wiederherstellen**, mit Fallback auf `streams`, wenn das Panel
  `enabled` false ist (z. B. „Dateien" ohne offenes Projekt). Alternative: immer `streams`.
  (Doc 10 §3.1/§7 / [[10-navigation-toolbar]] §3.1)
- **OE-51 Auto-Kollaps-Breakpoint** *(offen; Default gesetzt)*. **Default: bei schmalem Fenster
  automatisch in den Nur-Icon-Modus**, manuelle Präferenz separat persistiert und beim Verbreitern
  wiederhergestellt; Breakpoint im 900–1200-Bereich relativ zu `minWidth: 900` (`tauri.conf.json`) und
  zur Sidebar-Kollaps-Schwelle ([[02-dashboard]] §2). Alternative: rein manueller Kollaps.
  (Doc 10 §7 / [[10-navigation-toolbar]] §7)
- **OE-52 ✅ ENTSCHIEDEN — Auflösung der persistenten Sidebar** *(Sub-Punkt Titlebar-Controls offen)*.
  Die persistente Stream-`Sidebar` (`Sidebar.tsx`) wird **aufgelöst**: ihre Stream-Liste ist redundant
  mit dem `AgentGrid` (Anti-Pattern ggü. VS-Code-Activity-Bar-/Xcode-Navigator-/HIG-Sidebar-Muster).
  Der Default-Streams-View ist **Rail + Content (AgentGrid + Inspector)**, **ohne** Mittel-Panel; das
  Primary-Panel ist rein aktivitäts-spezifisch (Dateien/Settings), „Änderungen" ein Overlay (OE-41).
  Verbleib der Unikat-Elemente: Recent/Projekt → `RecentProjectsPopover`; Brand/About/Neuer-Stream →
  Rail; „Erledigt"-Gruppe → kollabierte Grid-Sektion; Sidecar-Health → Statusleiste; Off-Dashboard-
  Awareness über Rail-Badge auf „Streams" + Notification + `⌘1`-Rücksprung. **Noch offen (Feinheit):**
  Zuordnung der heutigen Titlebar-Controls — „+ Neuer Stream" in Rail **und** Titlebar (dieselbe
  Action); Auto-Sync-/Kollisions-Scan-Toggles ins Settings-Panel; Version-/Repo-/Sidecar-Pills + `↻`
  bleiben in der Titlebar — kein Doppel-SSOT, nur Spiegelung. (Doc 10 §1a/§2.3 / [[10-navigation-toolbar]] §1a/§11,
  [[02-dashboard]] §2/§9)

---

## Lese-Reihenfolge (Empfehlung)

1. **01 Architektur** (Dach: Schichten, Invarianten, Datenmodell, IPC).
2. **04 Sub-Agents** und **03 Main-Agent** (die zwei Rollen des Integrator-Modells).
3. **06 Region-Ownership & Koordination** (wie die beiden Rollen Konflikte *vor* dem Merge vermeiden).
4. **02 Dashboard** (die UI über dem Event-Bus).
5. **10 Navigations-Toolbar** (definiert das Layout: Activity-Rail + aktivitäts-spezifischer
   Primary-Panel-Umschalter, Auflösung der persistenten Sidebar, LAYOUT-CONTRACT — der Einstieg in
   die folgenden UI-Panels).
6. **07 Datei-Explorer & In-App-Editor** (das erste Panel mit direktem Datei-Zugriff; der Schicht-Test
   FS-durch-den-Core) und darauf aufbauend **08 Markdown-Editor** (der `.md`-Spezialfall des Editors).
7. **09 Change-Overview** (die räumliche Live-Diff-Ergänzung zur Dashboard-Timeline, teilt Diff-/FS-Stack
   mit 07/08 und das Kollisions-Overlay mit 06).
8. **05 Update-Bereich** (das Querschnitts-Beobachter-Subsystem).
