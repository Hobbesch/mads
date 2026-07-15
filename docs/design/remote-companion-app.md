# mads Remote — Konzept für eine iOS-Companion-App (iPad / iPhone)

> Status: **Konzept / Bau-Basis** (2026-07-07). Beschreibt eine eigenständige iOS-App
> **plus** die dafür nötige „Remote-Bridge" in mads selbst. Verankert im echten mads-Protokoll
> (`shared/protocol.ts`) und den vorhandenen Tauri-Datei-Befehlen (`src-tauri/src/files.rs`).
> Prosa deutsch, Code-/Protokoll-Begriffe englisch (wie im übrigen mads-Code).

---

## 1. Ziel & Umfang

**mads Remote** ist eine schlanke iOS-App (iPad + iPhone), die **eine im lokalen Netz laufende
mads-Instanz spiegelt** und **fernsteuert** — so, als säße man direkt an mads:

- **Spiegeln:** genau das darstellen, was mads gerade zeigt — Streams-Übersicht, Inspector
  (Chat-Verlauf, Status, Git/PR, Gate, Dev-Server), Kosten, Eskalationen, Berechtigungsanfragen.
- **Steuern:** dieselben Eingaben und Aktionen wie am Gerät — Nachrichten senden, Berechtigungen
  beantworten, PRs erstellen/mergen, Sync, Gate, Modell/Effort, Dev-Server starten/stoppen usw.
- **Instanzen umschalten:** mehrere mads-Instanzen (mads ist multi-instanzfähig) werden im Netz
  erkannt und sind in der App umschaltbar.
- **Markdown lesen & bearbeiten:** Datei-Baum durchsuchen, `.md` öffnen, editieren, speichern —
  mit demselben Modell wie in mads (Preview/Edit/Split/WYSIWYG, Optimistic-Concurrency).

**Nicht-Ziele:** kein eigenständiges mads (die App ist ein Client, kein zweiter Orchestrator);
kein Cloud-/Relay-Dienst (rein LAN); kein Ersatz für den Mac (die KI-Agenten, git, gh, Node,
Dev-Server laufen weiter auf dem Mac). Die App ist ein **Fenster + Fernbedienung**.

---

## 2. Leitprinzipien

1. **Thin client, dickes Backend.** Alle Logik (Agenten, git/gh, Dateisystem, Dev-Server) bleibt in
   mads. Die App rendert Zustand und sendet Intents — genau wie das mads-Frontend heute.
2. **Ein Protokoll für alle.** mads hat bereits eine saubere Nachrichten-Schnittstelle
   (`HostMessage` App→mads, `SidecarMessage` mads→App, NDJSON). Die Remote-App nutzt **dasselbe
   Protokoll** über das Netz statt über Tauri-IPC. Nichts wird neu erfunden.
3. **Gleiche Autorität = gleiche Sicherheit.** Eine gekoppelte Remote-App kann alles, was der
   Mensch am Gerät kann — inkl. Code ausführen (Agenten starten), pushen, mergen. Deshalb ist
   **Pairing + Auth + Verschlüsselung nicht optional, sondern der Kern** (siehe §9).
4. **mads bleibt Single Source of Truth.** Die App hält nur eine Spiegelkopie; bei Zweifel gilt der
   mads-Zustand. Reconnect löst immer ein frisches Re-Sync aus.
5. **Invarianten bleiben.** Die mads-Kern-Invarianten (nur der Integrator merged; außen-sichtbare
   Aktionen explizit; ein Worktree pro Sub-Stream) gelten auch für Remote-Befehle — ein per Remote
   ausgelöstes „Integrieren" durchläuft denselben Gate/Merge-Pfad.

---

## 3. Gesamtarchitektur

```
 ┌─────────────────────────┐        LAN (WLAN, mDNS + WSS/TLS)        ┌──────────────────────────────┐
 │   iPhone / iPad          │  ◄───────────────────────────────────►  │  Mac: mads-Instanz A          │
 │   „mads Remote" (SwiftUI)│                                          │  ┌─────────────────────────┐  │
 │                          │   1) Bonjour-Discovery                   │  │ Rust-Core (Tauri)       │  │
 │  • Instanz-Browser       │      _mads-remote._tcp                   │  │  + REMOTE BRIDGE (neu): │  │
 │  • Streams / Inspector   │   2) Pairing (PIN/QR) → Token            │  │   • mDNS advertise      │  │
 │  • Composer / Actions    │   3) WSS-Verbindung                      │  │   • WSS-Server + Auth   │  │
 │  • Markdown-Editor        │      • snapshot (Ist-Zustand)           │  │   • Tee SidecarEvents   │  │
 │  • Reducer (Store-Mirror)│      • event-stream (live deltas)        │  │   • Forward HostMsgs    │  │
 │                          │      • command (HostMessages)           │  │   • File-RPC (FsScope)  │  │
 │                          │      • file-rpc (md read/dir/write)      │  └───────────┬─────────────┘  │
 └─────────────────────────┘                                          │        stdio │ (unverändert) │
                                                                       │  ┌───────────┴─────────────┐  │
        (weitere Instanz B/C erscheinen als zusätzliche               │  │ Node-Sidecar (Agenten,  │  │
         Bonjour-Services und sind in der App umschaltbar)            │  │ git/gh, Worktrees, DevS)│  │
                                                                       │  └─────────────────────────┘  │
                                                                       └──────────────────────────────┘
```

**Kernidee:** In mads entsteht **eine neue Komponente, die „Remote-Bridge"**. Sie ist der einzige
netzseitige Teil; die App ist ein reiner Client. Die Bridge nutzt intern exakt die schon
vorhandenen Kanäle (SidecarChannelEvent-Stream, `sidecar_send`, die `mads_*`-Datei-Befehle) und legt
darüber Discovery, Auth, Transport.

---

## 4. Die mads-Seite: die Remote-Bridge

### 4.1 Wo sie lebt

**Empfehlung: im Rust-Core** (`src-tauri`). Begründung:

- Der Rust-Core **sieht bereits den kompletten Protokoll-Verkehr** (er relayed `SidecarChannelEvent`
  → Frontend und schreibt `HostMessage` → Sidecar-stdin). Er kann diesen Strom **teen**, ohne das
  NDJSON zu parsen — das respektiert die Regel „Rust bleibt dünn, parst das Protokoll nicht".
- Der Rust-Core **besitzt bereits die Datei-Befehle** (`files.rs`) inkl. des `FsScope`-Sicherheits­
  modells — die Bridge kann md-Lesen/-Schreiben direkt darüber bedienen.
- Gute Rust-Crates: `tokio` + `tokio-tungstenite` (WSS), `mdns-sd` oder `libmdns` (Bonjour),
  `rustls` (TLS).

**Alternative:** im Node-Sidecar (kennt den State, hat `ws` + fs). Nachteil: der Sidecar-stdout wird
schon vom Frontend konsumiert; man müsste sauber fan-outen, und die Datei-/Scope-Logik säße dann
doppelt. → Rust-Core ist die natürlichere Heimat. (Offene Entscheidung, §13.)

### 4.2 Was die Bridge tut (fünf Aufgaben)

| # | Aufgabe | Umsetzung |
|---|---------|-----------|
| 1 | **Advertise** | mDNS/Bonjour-Service `_mads-remote._tcp` mit TXT-Record: `name` (owner/repo), `host`, `pid`, `project` (repoRoot-Basename), `pv` (PROTOCOL_VERSION), `fp` (TLS-Fingerprint). Eine Instanz = ein Service. |
| 2 | **Pairing + Auth** | Erst-Kopplung per **PIN oder QR** (in mads angezeigt) → langlebiges, widerrufbares **Geräte-Token** (in iOS-Keychain). Danach nur noch Token nötig. Siehe §9. |
| 3 | **Live-Mirror** | Jede rohe `SidecarChannelEvent::Line` (NDJSON) wird zusätzlich an alle authentifizierten WSS-Clients gepusht (roher Durchlass, kein Parsen). Ebenso `Stderr`/`Exit` optional als Diagnose. |
| 4 | **Command-Forward** | `HostMessage` vom Client → wird wie ein lokaler `sidecar_send` roh in den Sidecar-stdin geschrieben. Ein Remote-Befehl == ein lokaler Befehl. |
| 5 | **File-RPC** | Request/Response für die 6 Datei-Befehle (§7.5, §12) — **durch dasselbe `FsScope`** wie lokal, mit **pro-Verbindung isoliertem** Root-Set (siehe §9). |

### 4.3 Snapshot beim Verbinden (der knifflige Teil)

Das mads-Frontend baut seinen Zustand **aus dem Event-Strom ab dem Verbindungszeitpunkt** auf. Ein
später verbindender Remote-Client braucht aber den **aktuellen Ist-Zustand**. Empfohlener Weg
(hält Rust dünn, keine Store-Serialisierung im Frontend nötig):

1. **Neuer HostMessage `request_snapshot`** (klein, im Sidecar zu ergänzen): der Orchestrator
   re-emittiert für den aktuellen Stand: `project_resolved`, je Agent `status_update` +
   `git_status` + `pr_update` + `gate_result` + `devserver_status` + `cost_update`, dazu
   `resumable_agents` und (falls vorhanden) `reconcile_summary`. → Der Client erhält den **Stream-
   Zustand** über exakt dieselben Nachrichten, die er ohnehin verarbeitet.
2. **Chat-Verlauf** je Stream lädt der Client per File-RPC aus `<repoRoot>/.mads/transcripts/<agentId>.json`
   (dieselbe Quelle, aus der das Frontend nach Neustart restauriert). Live-Events füllen die Lücke
   seit dem letzten Persist.

Damit **rebildet der Client denselben Reducer** wie der mads-Store (SidecarMessages → State) — ein
kohärentes, konsistentes Modell. **Reconnect** = erneutes `request_snapshot` + Transcript-Reload.

> Alternative (Fallback): das Frontend serialisiert seinen zustand-Store und liefert ihn der Bridge
> auf Anfrage. Mächtiger (auch rein frontend-seitige Ableitungen wie `editsByFile`), aber koppelt
> die Bridge ans Frontend. Der `request_snapshot`-Weg wird bevorzugt; `editsByFile`/`devLog` leitet
> der Client selbst aus dem Event-Strom ab (wie der Store).

---

## 5. Instanz-Discovery & Umschalten

- Die App startet einen **`NWBrowser`** (Network.framework) auf `_mads-remote._tcp` und zeigt alle
  gefundenen Instanzen als Liste: *„owner/repo — host (paix)"*, mit Online-Punkt.
- **Umschalten** = Verbindung zur alten Instanz trennen, zur neuen WSS verbinden, `request_snapshot`.
  Jede Instanz hat **eigenen State** in der App (eigener Reducer-Store), sodass Zurückschalten sofort
  den letzten Stand zeigt (plus frisches Re-Sync).
- Erstmalig unbekannte Instanz → **Pairing-Flow** (§9). Bekannte (Token vorhanden) → direkt verbinden.
- Da mads multi-instanzfähig ist, können mehrere Services auftauchen (auch mehrere Macs). Der
  TXT-Record `project`/`pid`/`host` macht sie unterscheidbar.

---

## 6. Das Protokoll über die Leitung

Ein einziger **WSS-Kanal** (TLS) pro Instanz, Text-Frames, jede Frame = eine JSON-Nachricht
(NDJSON-kompatibel). Vier logische „Ebenen" über denselben Socket, unterschieden durch ein
Hüllfeld:

```jsonc
// Envelope (angelehnt an mads BaseMsg): { v, id, ts } + plane-spezifische Felder
{ "v": 1, "id": "uuid", "ts": 1720000000000, "channel": "command",  "msg": { "type": "send_input", "agentId": "…", "text": "…" } }
{ "v": 1, "id": "…",    "ts": …,             "channel": "event",    "msg": { "type": "agent_event", "agentId": "…", "event": {…} } }
{ "v": 1, "id": "…",    "ts": …,             "channel": "snapshot",  "…": … }
{ "v": 1, "id": "req1", "ts": …,             "channel": "file-rpc", "op": "read_file", "args": { "path": "…" } }
{ "v": 1, "id": "req1", "ts": …,             "channel": "file-rpc-reply", "ok": true, "result": {…} }
```

| Ebene | Richtung | Inhalt |
|-------|----------|--------|
| `command` | App → mads | rohe `HostMessage` (identisch zu `sidecar_send`) — siehe §7 & Anhang A |
| `event` | mads → App | rohe `SidecarMessage` (Live-Mirror) + optional `stderr`/`exit`-Diagnose |
| `snapshot` | mads → App | initialer Ist-Zustand (via `request_snapshot`, §4.3) |
| `file-rpc` / `-reply` | beide | Request/Response für die Datei-Befehle, korreliert über `id` |

**Transport-Regeln:** geordnete Zustellung (WS garantiert Reihenfolge pro Socket), Heartbeat/Ping
alle ~15 s, Backpressure-tolerant (Dev-Server-Logs können viel sein — mads deckelt Zeilenlänge
bereits). Binärdaten (Bild-Paste, `write_file_bytes`) als Base64 im JSON **oder** als separate
Binär-Frame mit `id`-Korrelation (Performance-Entscheidung, §13).

---

## 7. Was die App spiegelt & steuert (Feature-Map)

Alles unten ist **eine 1:1-Abbildung** vorhandener Nachrichten/State — nichts Neues in der Semantik.

### 7.1 Streams-Übersicht (spiegeln)
Aus `agents: Record<id, AgentVM>` + `order`. Kachel je Stream mit: Label, Rolle
(`integrator`/`sub`), Status (`AgentStatus`), Modell/Effort, Branch, `behind/ahead/dirty`, PR-Badge,
Gate ✓/✖, Dev-Server ▶, Kosten. `live?`-Flag → passive („fertige") Streams sind erkennbar und per
„Fortsetzen" reaktivierbar.

### 7.2 Inspector / Detail (spiegeln)
- **Chat-Verlauf** aus `events[agentId]` (Ringpuffer 800). `TimelineEvent`-Kinds: `user` (Text +
  Bilder), `assistant`, `thinking`, `tool` (Karten: name/command/output/ok/running), `todos`,
  `notice` (tone info/warn/err/ok/accent).
- **Status-Kopf:** `status`, `currentStep`, Laufzeit, Kosten/Turns/Tokens (`cost_update`).
- **Git/PR:** `git_status` (behind/ahead/dirty, syncBlocked), `pr_update` (`PullRequestInfo`), Gate
  (`gate_result` → Steps).
- **Dev-Server:** `devserver_status` (state, url, services) + Live-Log aus `devserver_log`.

### 7.3 Composer & Eingaben (steuern)
| Aktion | HostMessage |
|--------|-------------|
| Nachricht senden (+ Bilder) | `send_input { agentId, text, images? }` |
| Turn unterbrechen | `interrupt_agent { agentId }` |
| Berechtigung/Frage beantworten | `answer_permission { agentId, requestId, decision }` |
| Permission-Mode ändern | `set_permission_mode { agentId, mode }` |

Berechtigungsanfragen (`permission_request`) und Aufmerksamkeitsrufe (`needs_input`) sollten in der
App **prominent** (Banner + lokale Notification) erscheinen — so kann man aus der Ferne freigeben.

### 7.4 Aktionen / Buttons (steuern)
| Button | HostMessage |
|--------|-------------|
| Neuer Stream | `start_agent { … }` |
| PR erstellen | `create_pr { agentId, title?, body?, draft? }` |
| Sync (rebase) | `sync_branch { agentId }` |
| Mergen & weiter / Integrieren | `integrate_pr { agentId, method?, keepBranch? }` |
| main aktualisieren (FF) | `update_main { agentId }` |
| In Sub-Stream auslagern | `outsource_main { integratorId, agentId, label, branch }` |
| Gate ausführen | `gate_task { agentId }` |
| Modell/Effort umschalten | `set_model_effort { agentId, model?, effort? }` |
| Autopilot-Stufe | `set_autopilot { agentId, level }` |
| Autonomie (Auto-Sync/Kollision) | `set_autonomy { config }` |
| Dev-Server starten/stoppen | `start_devserver` / `stop_devserver { agentId }` |
| Stoppen / Aufräumen | `stop_agent` / `cleanup_worktree` |
| Status jetzt aktualisieren | `poll_project` |

> **Politik-Entscheidung (§13):** außen-sichtbare Aktionen (`create_pr`, `integrate_pr`, push) kann
> die Remote wie am Gerät auslösen. Optional strenger: solche Aktionen aus der Ferne **zusätzlich**
> bestätigen lassen (2. Faktor am Mac oder in der App), da die Remote sonst voll durchgreift.

### 7.5 Markdown lesen & bearbeiten (steuern, über File-RPC)
Gleiche Sequenz wie in mads (`MarkdownEditor` / `files.rs`), nur über die Leitung:
1. `register_root(rootPath)` — Scope einmalig setzen (Projekt- oder Worktree-Root).
2. `read_dir(path)` — Baum lazy laden (Server sortiert, filtert `.git`/`node_modules`/`.env*`, Cap).
3. `read_file(path)` → `FileRead` (Core entscheidet Text/Binär; liefert `{mtimeMs, size, hash,
   truncated}`). `.md` → Editor.
4. Bearbeiten: lokaler Puffer; **`dirty` = Puffer ≠ geladener Text** (abgeleitet, nicht gespeichert).
   Modi: Preview / Edit / Split / WYSIWYG.
5. `write_file(path, content, baseMtimeMs, baseSize, baseHash)` → `saved{…}` | **`conflict`**
   (Optimistic-Concurrency: kein Überschreiben bei Drift → Konflikt-Sheet mit Reload/Überschreiben).
6. Bild einfügen: `write_file_bytes(<dir>/assets/…)` + `![](./assets/…)` in den Puffer splicen.

Die App muss **dasselbe Puffer-/Dirty-/Optimistic-Concurrency-Modell** nachbilden (siehe §8.4).

---

## 8. Die iOS-App

### 8.1 Technik
- **SwiftUI**, iOS/iPadOS **17+** (empfohlen; ältere Ziele erhöhen Aufwand für md-Rendering).
- **Discovery:** `NWBrowser` (Network.framework) auf `_mads-remote._tcp`.
- **Transport:** `URLSessionWebSocketTask` (einfach) **oder** `NWConnection` mit TLS (mehr Kontrolle,
  Cert-Pinning) — Empfehlung `NWConnection`/`rustls`-kompatibles TLS wegen TOFU-Pinning (§9).
- **Persistenz:** Keychain (Token, gepinnter Server-Fingerprint), kleine lokale Caches (letzte
  Instanz, UI-Prefs). Kein Klartext-Secret.
- **Nebenläufigkeit:** Swift Concurrency (async/await, `AsyncStream` für den Event-Strom).

### 8.2 Navigation / Layout
- **iPad — `NavigationSplitView` (3 Spalten):** *Instanzen* → *Streams* → *Inspector/Detail*.
  Markdown-Editor als eigene Detail-Spalte oder Vollbild-Sheet. Nutzt die Fläche wie mads am Mac.
- **iPhone — `NavigationStack`:** Instanzen → Streams → Stream-Detail (Chat + Aktionen) → (separat)
  Datei-Baum → Markdown-Editor. Composer als unten angedockte Leiste.
- **Gemeinsame Chrome:** Verbindungsstatus-Indikator, Instanz-Umschalter (Toolbar-Menü),
  Berechtigungs-/Eskalations-Banner.

### 8.3 State / Reducer
Ein beobachtbarer Store je verbundener Instanz, der **denselben Reducer wie der mads-zustand-Store**
implementiert: `apply(SidecarMessage)` patcht `Stream`-Objekte, hängt `TimelineEvent`s an (Ringpuffer
800), verwaltet `permissions`, `devLog`, `editsByFile` (aus Tool-Events abgeleitet), `project`,
`reconcile`, `collisions`. Snapshot initialisiert, Live-Events aktualisieren. **Codable-Structs**
spiegeln die Protokoll-Typen (§10, Anhang A).

### 8.4 Markdown-Editor auf iOS
- **Lesen/Preview:** gerenderte Markdown-Ansicht. Optionen: Apple `swift-markdown` →
  `AttributedString`, **oder** eine sanitisierte `WKWebView`-Preview (näher an mads' GitHub-Pipeline;
  Achtung XSS — nur sanitisiertes HTML, wie mads es tut).
- **Bearbeiten:** Quell-Editor mit Markdown-Syntax-Highlighting. Optionen: `UITextView`-basiert mit
  eigenem Highlighter, eine SwiftUI-Editor-Lib, **oder** CodeMirror-6 in einer `WKWebView`
  (maximale Nähe zu mads' `MarkdownSource`/`cmMarkdown`, inkl. In-Doc-Suche & Live-Preview — aber
  mehr Web-Brücke). Toolbar (Bold/Italic/Code/Link/Heading), In-Doc-Suche.
- **Speichern & Konflikt:** exakt das Optimistic-Concurrency-Modell — beim Öffnen `{mtimeMs, size,
  hash}` merken, beim Speichern mitschicken; `conflict` → Sheet „Neu laden / Überschreiben /
  Meine Version behalten" (wie mads `ConflictSheet`).
- **Dirty:** abgeleitet (Puffer ≠ geladener Text) → ● + aktiver Speichern-Button; ⌘S auf iPad-Tastatur.

### 8.5 Reconnect, Hintergrund, Angebundenheit
- WS wird im **Hintergrund** von iOS suspendiert → beim Zurückkehren **automatisch reconnecten** +
  `request_snapshot` + Transcript-Reload. Ungespeicherte md-Puffer bleiben lokal erhalten.
- Verbindungsabbruch → klarer „getrennt"-Zustand, Aktionen deaktiviert (kein Fake-Erfolg),
  automatischer Wiederverbindungsversuch mit Backoff.
- Optionale **lokale Notifications** für `permission_request` / `error`-Eskalationen, damit man auch
  bei geschlossener App zum Freigeben gerufen wird (nur LAN-lokal ausgelöst).

---

## 9. Sicherheit & Vertrauen (kritisch)

Eine gekoppelte Remote **kann Code auf dem Mac ausführen** (Agenten starten), pushen und mergen. Das
ist gewollt („als säße ich an mads"), macht Auth aber zur Pflicht.

1. **LAN-only, kein Relay.** Bridge lauscht nur auf lokalen Interfaces; keine Cloud, kein
   Port-Forwarding empfohlen. (Fern-Zugriff bewusst außen vor — sonst über VPN des Nutzers.)
2. **Explizites Pairing.** Neue Geräte müssen **in mads bestätigt** werden: mads zeigt PIN/QR, die
   App scannt/tippt. Ergebnis: ein **pro-Gerät-Token** (widerrufbar; mads listet gekoppelte Geräte).
3. **Transportverschlüsselung.** WSS mit TLS. Da es keine CA im LAN gibt: **selbstsigniertes Zert +
   Trust-On-First-Use-Pinning** beim Pairing (Fingerprint im TXT-Record + in der Keychain gepinnt).
   Alternative: Noise-Protokoll über TCP.
4. **Autorisierung pro Verbindung.** Jede WSS-Frame trägt/braucht ein gültiges Token. Ohne → keine
   `command`/`file-rpc`.
5. **Pro-Verbindung isolierter `FsScope`.** Heute ist `FsScope` **prozessglobal** — im Netz muss der
   Root-Allow-Set **pro Client** geführt werden, sonst weitet ein Client mit `register_root` das
   Dateisystem für alle. Der **Deny-First-Schutz** (`.env`, `id_rsa`, `.ssh`, `.git`, `*.pem` … nie
   lesbar) und die **Ablehnung zu breiter Roots** (`/`, `$HOME`, System-Pfade) bleiben erhalten —
   notwendig, aber im Netz **nicht hinreichend** ohne Auth.
6. **Außen-sichtbare Aktionen.** `create_pr`/`integrate_pr`/push bleiben explizit; optional aus der
   Ferne zusätzlich bestätigen (§13). mads-Invarianten (nur Integrator merged) gelten unverändert.
7. **Audit & Widerruf.** Bridge protokolliert Remote-Befehle (SQLite-Audit, das mads ohnehin
   vorsieht); der Nutzer kann Geräte-Token jederzeit widerrufen; Pairing lässt sich global abschalten.

---

## 10. Datenmodell der App (Auszug, Codable — spiegelt `shared/protocol.ts`)

```swift
struct Instance: Identifiable {           // aus Bonjour-TXT
  let id: String                          // host+pid
  var name: String                        // "owner/repo"
  var project: String                     // repoRoot-Basename
  var host: String; var port: UInt16
  var fingerprint: String; var paired: Bool
}

struct Stream: Identifiable {             // == AgentVM
  let id: String
  var label: String; var role: Role       // integrator|sub
  var status: AgentStatus                  // starting|running|waiting_input|paused|escalation|error|done|queued
  var currentStep: String?
  var model: String?; var effort: Effort?  // low|medium|high|xhigh|ultracode
  var permissionMode: PermissionMode; var autopilot: Autopilot
  var costUsd: Double; var numTurns: Int; var inputTokens: Int; var outputTokens: Int
  var branch: String?; var worktreePath: String?
  var behind: Int; var ahead: Int; var dirty: Bool; var syncBlocked: Bool?
  var pr: PullRequestInfo?; var gate: Gate?; var devServer: DevServer?
  var live: Bool?
}

enum TimelineEvent {                       // Ringpuffer je Stream
  case user(text: String, images: Int)
  case assistant(text: String)
  case thinking(text: String)
  case tool(id: String, name: String, command: String?, output: String?, ok: Bool?, running: Bool)
  case todos([TodoItem])
  case notice(tone: NoticeTone, text: String)
}

struct PermissionRequest: Identifiable {   // → prominenter Banner / Notification
  let requestId: String; let agentId: String
  var toolName: String; var kind: PermKind  // tool | ask_user_question
  var questions: [AskQuestion]?
}

struct DevServer { var state: DevState; var url: String?; var services: [Service]; var message: String? }
struct OpenFile { var path: String; var loadedText: String; var mtimeMs: Double; var size: Int; var hash: String; var truncated: Bool }
```

---

## 11. Phasenplan

| Phase | mads-Seite (Bridge) | iOS-App | Ergebnis |
|-------|---------------------|---------|----------|
| **P0** | WSS-Server + mDNS-Advertise + Pairing/Token + TLS(TOFU) + `request_snapshot` (neuer HostMessage) + Tee des Event-Streams + Command-Forward | — | Bridge steht; mit `wscat` testbar |
| **P1** | File-RPC über bestehende `mads_*`-Befehle, **pro-Verbindung-Scope** | Discovery + Pairing + Verbindung + Reducer + **Read-only-Mirror** (Streams-Grid, Inspector, Chat) | Man sieht mads live auf dem iPad |
| **P2** | (stabilisieren) | **Steuern**: send_input, answer_permission, alle Aktions-Buttons, interrupt | Fernsteuerung wie am Gerät |
| **P3** | (File-RPC härten) | **Markdown**: Baum, öffnen, editieren, speichern (+ Konflikt-Sheet, Bild-Paste) | md lesen/bearbeiten wie in mads |
| **P4** | (mehrere Clients) | **Instanz-Umschalter** (mehrere Bonjour-Services, eigener State je Instanz) | Zwischen Boba/paix-Instanzen wechseln |
| **P5** | Audit, Widerruf-UI, Rate-Limit | Reconnect-UX, lokale Notifications (Permissions/Eskalationen), Diktat (Text senden), Politur | Robuste, angenehme Fernbedienung |

---

## 12. Anhang B — Datei-RPC (aus `files.rs`, unverändert in Semantik)

| Op | Args | Ergebnis / Verhalten |
|----|------|----------------------|
| `register_root` | `path` | Root in **pro-Verbindung-Scope** aufnehmen (read+write). Lehnt `/`, `$HOME`, System-Pfade und &lt;2-Segment-Pfade ab. |
| `read_dir` | `path` | `DirNode[]` (dirs-first, gefiltert `.git`/`node_modules`/`.env*`, Cap `DIR_ENTRY_CAP`). |
| `read_file` | `path` | `FileRead` = text|binary (Core-UTF-8-Probe) + `{ mtimeMs, size, hash, truncated }`. Text-Cap 2 MB, Bild 5 MB→binär. |
| `write_file` | `path, content, baseMtimeMs, baseSize, baseHash` | `saved{mtimeMs,size,hash}` \| **`conflict`** (Optimistic-Concurrency; neue Datei überspringt Check). |
| `write_file_bytes` | `path, bytes` | schreibt Binär (z. B. Bild) + `create_dir_all` des (in-scope) Parents. |
| `save_transcript` / `load_transcript` | `agentId, …` | Verlauf unter `<repoRoot>/.mads/transcripts/<id>.json` (agentId sanitisiert, dann `ensure_in_scope`). |

**`FsScope`-Regeln (immer, auch remote):** (1) **Deny-First** — geschützte Ordner/Secret-Dateinamen
nie zugreifbar; (2) **Canonicalize** (auch fehlende Zielpfade), Deny auf dem Canonical-Pfad
erneut prüfen (Symlink-sicher); (3) **Prefix-Assertion** gegen registrierte Roots; leere Root-Liste
= harter Fehler. Pfade sind **host-lokal absolut** — die App originiert Pfade **nie selbst**, sondern
arbeitet nur mit vom Host gelieferten Pfaden (Ordner-Picker/`register_root` laufen auf dem Mac).

---

## 13. Offene Entscheidungen (mit Default)

| # | Frage | Default / Empfehlung |
|---|-------|----------------------|
| OE-R1 | Bridge in Rust-Core oder Sidecar? | **Rust-Core** (sieht Protokoll roh, besitzt Datei-Befehle, bleibt dünn) |
| OE-R2 | Snapshot-Quelle | **`request_snapshot` (Sidecar re-emittiert)** + Transcripts; Fallback: Frontend serialisiert Store |
| OE-R3 | TLS-Modell | **Selbstsigniert + TOFU-Pinning** beim Pairing (Fingerprint im TXT-Record); Alt.: Noise |
| OE-R4 | Auth | **PIN/QR-Pairing → pro-Gerät-Token** (Keychain), widerrufbar |
| OE-R5 | Außen-sichtbare Aktionen aus der Ferne | erlaubt wie am Gerät; **optional** Extra-Bestätigung |
| OE-R6 | Binär-Transport | Base64-im-JSON (einfach) vs. **Binär-Frame** (Perf) — mit Bild-Paste entscheiden |
| OE-R7 | md-Editor iOS | **CodeMirror-6 in WKWebView** (Nähe zu mads) vs. nativer `UITextView`+Highlighter |
| OE-R8 | Spiegel-Umfang | **eine Instanz aktiv** darstellen; mehrere nur im Umschalter (nicht gleichzeitig live) |
| OE-R9 | Reichweite | **rein LAN**; Fern-Zugriff nur über nutzereigenes VPN, kein eigener Relay-Dienst |

---

## Anhang A — Protokoll-Referenz (aus `shared/protocol.ts`)

### HostMessage (App → mads) — `channel:"command"`
`open_project`(projectId,repoRoot,force?) · `set_project`(project) · `poll_project` ·
`start_agent`(agentId,prompt,repoRoot?,branch?,baseRef?,model?,effort?,permissionMode?,role?,label?,…) ·
`send_input`(agentId,text,images?) · `answer_permission`(agentId,requestId,decision) ·
`interrupt_agent`(agentId) · `set_permission_mode`(agentId,mode) · `stop_agent`(agentId,removeWorktree?) ·
`cleanup_worktree`(agentId,branch?,worktreePath?,force?) · `create_pr`(agentId,title?,body?,draft?) ·
`sync_branch`(agentId) · `integrate_pr`(agentId,method?,keepBranch?) · `update_main`(agentId) ·
`outsource_main`(integratorId,agentId,label,branch) · `gate_task`(agentId) · `set_autonomy`(config) ·
`set_autopilot`(agentId,level) · `set_model_effort`(agentId,model?,effort?) ·
`start_devserver`(agentId) · `stop_devserver`(agentId) · `shutdown` ·
**[neu für Remote]** `request_snapshot`.

### SidecarMessage (mads → App) — `channel:"event"` / `"snapshot"`
`sidecar_ready` · `project_resolved`(project) · `project_locked`(repoRoot,byPid?) ·
`agent_event`(agentId,event: assistant_text|assistant_delta|thinking|tool_use|tool_result|system) ·
`needs_input`(agentId,reason,message?) · `permission_request`(agentId,requestId,toolName,input,kind,questions?) ·
`status_update`(agentId,status,currentStep?) · `cost_update`(agentId,totalCostUsd,numTurns,inputTokens?,outputTokens?) ·
`agent_done`(agentId,subtype,resultText?,isError) · `worktree_created`(agentId,path,branch,baseRef) ·
`git_status`(agentId,behind,ahead,dirty,syncBlocked?) · `pr_update`(agentId,pr?) ·
`merge_result`(agentId,ok,reasons,prNumber?) · `gate_result`(agentId,ok,steps) ·
`resumable_agents`(agents) · `reconcile_summary`(mainBehind,mainFastForwarded,mainBlocked?,…,seedGenerated?) ·
`collision_warning`(…) · `spawn_substreams_request`(…) · `devserver_status`(agentId,state,services?,url?,message?) ·
`devserver_log`(agentId,service,stream,line) · `error`(agentId?,scope,code,message,recoverable).

### Transport-Hülle (heute Tauri, künftig WSS)
`SidecarChannelEvent` = `Line{line}` (rohes NDJSON stdout) · `Stderr{line}` · `Exit{code}`.
Jede `HostMessage`/`SidecarMessage` trägt `BaseMsg { v: PROTOCOL_VERSION, id, ts }`.
