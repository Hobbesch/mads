# 08 — Markdown-Editor (mads)

> Status: Design, implementierungsreif. Stand: 2026-06-22.
> Sprache: Deutsch (Code/Identifier englisch).
> Quellen: [[07-file-explorer]] (gemeinsamer CodeMirror-6-Unterbau, `mads_read_file`/`mads_write_file`-Core-Commands, fs-Scope), [[06-ownership-and-coordination]] §§4–5 (Koordinations-Artefakte als editierbare `.md`), [[02-dashboard]] §2 (Layout/`.body`-Split), [[01-architecture]] §2.2 (Schicht-Verantwortung), CLAUDE.md §„Schichten"/§„Kern-Invarianten".
> Versionsbezüge sind gegen die installierten Pakete zu verifizieren (siehe [[tauri2-stack]]); package.json-/Cargo.toml-Bumps unterliegen dem paix-Shared-File-Protokoll (CLAUDE.md „Build & Gates").

---

## 0. Zusammenfassung & Einordnung

**Der Markdown-Editor ist die In-App-Lese- und Schreiboberfläche für `.md`-Dateien** — Design-Docs (`docs/design/*.md`), README, und vor allem die **Koordinations-Artefakte** aus [[06-ownership-and-coordination]] (`docs/coordination/<name>.md`, das `OwnershipDoc` in seiner Datei-Repräsentation). Er liefert zweierlei in einer Komponente:

1. **Render-Modus** — schön formatiertes, GitHub-ähnlich gerendertes Markdown (gut leserlich): `react-markdown` + `remark-gfm` (beide bereits im Repo, in `MessageTimeline.tsx` als `Md` produktiv), erweitert um eine **rehype-Pipeline** mit `github-markdown-css`-Look, Syntax-Highlighting für Codeblöcke (`rehype-starry-night` — GitHubs eigene PrettyLights-Grammatiken), **`rehype-sanitize`** für untrusted/agent- oder PR-geschriebenes Markdown (keine Script-Ausführung), volle GFM (Tabellen, Task-Listen, Strikethrough, Autolinks, Footnotes), Heading-Anchors/TOC, Auflösung der projektspezifischen **`[[wikilinks]]`** auf `./<name>.md` über ein kleines custom remark-Plugin, externe Links sicher über `@tauri-apps/plugin-opener` (Bestätigung).
2. **Edit-Modus** — GitHub-artige Umschaltung **Edit/Preview** (oder Split mit Scroll-Sync). Quell-Editor ist **CodeMirror 6** (`@codemirror/lang-markdown`) — **derselbe Editor-Unterbau wie der Code-Editor in [[07-file-explorer]]**. Formatierungs-Toolbar (bold/italic/heading/list/link/table/code) + Tastatur-Shortcuts, Bild-Einfügen per Paste (an `blobToBase64`/`onPaste` in `Inspector.tsx` angelehnt: Bild ins Repo speichern + relativen Link einfügen). Speichern über `tauri-plugin-fs`/Core-Command (gescoped), Dirty-State, optionales Autosave.

Der Editor erbt seinen Datei-Zugriff **vollständig** von [[07-file-explorer]]: er liest und schreibt **nie** selbst die Disk, sondern über die in [[07-file-explorer]] §4 definierten Core-Commands `mads_read_file` / `mads_write_file`. Das ist die nicht verhandelbare Schicht-Grenze (siehe §5).

**Die drei paix-Invarianten — auch hier bindend** (CLAUDE.md §„Kern-Invarianten", [[_paix-multi-agent-reference]]):

1. **Nur der Integrator merged** nach `main` — der Editor schreibt nur in **Working-Trees** (Haupt-Checkout `project.repoRoot` oder Sub-Worktree `agent.worktreePath`), erzeugt **nie** Commits/PRs/Merges. Speichern ≠ committen.
2. **`main` immer lauffähig** — der Editor berührt CI/Merge nicht; ein gespeichertes (noch un-committetes) `.md` ist nur Working-Tree-Änderung, sichtbar als `dirty` im bestehenden `git_status`-Fluss.
3. **Außen-sichtbare Aktionen sind explizit** — externe Links werden nie automatisch geöffnet (Opener mit Bestätigung), Bilder werden lokal ins Repo geschrieben (kein Upload), kein Netzwerk-Fetch von eingebetteten Ressourcen (sanitize blockt `srcset`/remote-`<img>` nach Schema).

### Querverweise / Einordnung

| Dokument | Beziehung zu diesem Dok |
|---|---|
| [[07-file-explorer]] | **Eltern-Feature.** Liefert den CodeMirror-6-Unterbau, die fs-Core-Commands (`mads_read_dir`/`mads_read_file`/`mads_write_file`), die fs-Scope-Capability und den Datei-Öffnungs-Intent. Der MD-Editor ist der `.md`-Spezialfall des generischen Datei-Editors. |
| [[09-change-overview]] | Teilt den CodeMirror-6-/`@codemirror/merge`-Stack; ein im Editor gespeichertes (un-committetes) `.md` taucht dort als `dirty`-Datei auf. Beim Speichern einer Datei, die ein anderer Stream besitzt/berührt, greift die Kollisions-/Trespass-Markierung (§5, §7). |
| [[06-ownership-and-coordination]] | **Primärer Nutzer.** Koordinations-Artefakte (`OwnershipDoc` als `docs/coordination/<name>.md`) und der README-Ownership-Block werden hier in-App editiert; deren `[[wikilinks]]` und Regel-Tabellen rendert der Render-Modus. |
| [[02-dashboard]] | Definiert das `.app`/`.body`-Layout (Sidebar │ main; center │ inspector). Der Editor mountet als Panel in `.body` (§2) und nutzt ausschließlich die `:root`-CSS-Variablen aus `src/App.css`. |
| [[01-architecture]] | §2.2 Schicht-Verantwortungstabelle („Darf NICHT"): begründet, warum aller FS-Zugriff durch den Rust-Core läuft und `src/` reine UI bleibt. |

---

## 1. UX & Interaktionsdesign

### 1.1 Drei Zustände, ein Dokument

Eine geöffnete `.md`-Datei lebt in genau einem von drei View-Modi, umschaltbar wie auf GitHub (Segmented Control, macOS-HIG-konform):

| Modus | Inhalt | Default für |
|---|---|---|
| **Preview** | nur Render (`react-markdown`-Pipeline, `.markdown-body`) | Design-Docs/README lesen, Artefakt-Review |
| **Edit** | nur CodeMirror-6-Quell-Editor (`@codemirror/lang-markdown`) | gezieltes Schreiben |
| **Split** | links CodeMirror, rechts Live-Preview, **Scroll-Sync** | längeres Editieren mit Sofort-Feedback |

> **ENTSCHIEDEN (Default-View, OE-36):** `.md`-Dateien öffnen **im Preview-Modus** (leserlich zuerst, GitHub-Analogie). Edit/Split sind ein Klick (oder `⌘⏎`) entfernt. Der zuletzt gewählte Modus wird pro Session gemerkt (`editorViewMode` im Store, §3), nicht persistiert (OE-3: „MVP = ein Fenster", kein Settings-Store). Der View-Modus ist **global** (ein einziger `editorViewMode`), weil im Editor-Slot (`.center`, OE-38) **genau eine** `.md` zur Zeit offen ist — es gibt im MVP keine Datei-Tabs (07 §10, Post-MVP). `editorBuffers` sind dagegen **pro Pfad** und überleben den Datei-Wechsel (§6), aber sichtbar ist nur der Modus der aktiven Datei.

### 1.2 Flows

- **Öffnen** — aus [[07-file-explorer]]: Klick auf eine `.md`-Datei → `openFilePath(path)` (Store-Action, in [[07-file-explorer]] §3.2 definiert) → Core liest Inhalt → Editor-Panel zeigt **Preview**. Öffnen einer `.md` aus einem Sub-Worktree öffnet sie read-anchored an `agent.worktreePath`.
- **Editieren** — Umschalten auf Edit/Split → Tippen mutiert den `editorBuffer[path]` (kein Disk-Schreiben). `editorDirty[path]` kippt auf `true`, der Datei-Tab/Header bekommt einen Dirty-Punkt `●`.
- **Speichern** — `⌘S` oder Toolbar → `saveFile(path)` → Core `mads_write_file` → bei Erfolg `editorDirty[path] = false`, Notice „Gespeichert". **Speichern ist kein Commit** (§0, Invariante 1).
- **Autosave (optional, Post-MVP-ready)** — debounced (1500 ms) wenn `autosaveEnabled`; default **aus** (siehe OE-37).
- **Bild-Paste** — `⌘V` mit Bild im Clipboard → Bild wird (analog `blobToBase64` in `Inspector.tsx`) nach `<dir>/assets/<ts>-<n>.png` im selben Working-Tree geschrieben (`mads_write_file`, binär), und ein **relativer** Markdown-Link `![](./assets/<ts>-<n>.png)` an der Cursor-Position eingefügt.
- **Wikilink-Navigation** — Klick auf `[[name]]` im Preview → öffnet `./<name>.md` (relativ zur aktuellen Datei) im selben Panel, sofern in-scope; existiert sie nicht, „rote" Link-Darstellung + Tooltip „Datei nicht gefunden".
- **Externer Link** — Klick → `openUrl(href)` (`@tauri-apps/plugin-opener`), wie heute in `Md` (`MessageTimeline.tsx` Z.18–28), aber mit Bestätigungs-Dialog bei nicht-`https`-Schemata (§5).

### 1.3 Layout-Skizze (Split-Modus, im `.body` als drittes Panel)

```
┌ .app ─────────────────────────────────────────────────────────────────────┐
│ rail │ .sidebar │ .main                                                     │
│  ▢   │  Streams │ ┌ .titlebar  "docs/coordination/mail-parallel.md"  ●dirty ┐│
│  ▣   │  Files   │ │  [Preview] [Edit] [Split]            ⌘S Speichern  ⟲    ││
│  ▢   │  Changes │ ├ .md-editor ────────────────────────────────────────────┤│
│      │          │ │ B I H ▸ • 1. 🔗 ⊞ </> │  (Toolbar; nur Edit/Split)      ││
│      │          │ ├──────────────────────┬──────────────────────────────────┤│
│      │          │ │ # Ownership          │  Ownership                       ││
│      │          │ │                       │  ─────────                       ││
│      │          │ │ - `pst.py` → stream-A │  • pst.py → stream-A            ││
│      │          │ │ - [[04-sub-agents]]   │  • 04-sub-agents (wikilink)     ││
│      │          │ │ CodeMirror 6 (source) │  .markdown-body (Live-Preview)  ││
│      │          │ │   ⇕ Scroll-Sync ⇕     │   ⇕ Scroll-Sync ⇕               ││
│      │          │ └──────────────────────┴──────────────────────────────────┘│
└────────────────────────────────────────────────────────────────────────────┘
```

> **OFFENE FRAGE (Panel-Platzierung):** Der Editor ersetzt im „Files"-View die `.center`-Spalte (so bleibt der Inspector sichtbar für den laufenden Stream) **oder** spannt als breites Panel über die ganze `.body`-Zeile (mehr Schreibfläche, Inspector verdeckt). Empfehlung MVP: **`.center`-Slot** (geringste Layout-Friktion, das Layout aus [[02-dashboard]] §2 bleibt intakt; `.center` ist bereits scroll-fähig mit `.center-title`). Konsolidiert als OE-38.

### 1.4 macOS-HIG-Details

- Segmented Control (Preview/Edit/Split) im Editor-Header, Stil wie `.toggle`/`.pill` aus `src/App.css`.
- Dirty-Indikator als gefüllter Punkt `●` im Titel (macOS-Konvention für ungesicherte Dokumente), nicht als „*".
- Keine eigenen Farben — ausschließlich `:root`-CSS-Variablen (`--panel`, `--panel-2`, `--border-strong`, `--accent`, `--text`, `--mono`); folgt OS-Light/Dark automatisch (kein In-App-Toggle, [[02-dashboard]]).
- CodeMirror-Theme via `EditorView.theme(...)` an dieselben Variablen gebunden (eine geteilte Theme-Factory mit [[07-file-explorer]]).

---

## 2. Komponenten-Architektur

Alle neuen Komponenten landen unter `src/components/` und sind **reine UI** (rendern Store-State, senden Intents/Actions — kein Prozess, kein FS, kein git/gh; [[01-architecture]] §2.2 „Darf NICHT").

### 2.1 Neue Komponenten

| Komponente | Datei | Verantwortung | Props |
|---|---|---|---|
| `MarkdownEditor` | `src/components/MarkdownEditor.tsx` | Orchestrator: Header (View-Switch, Save, Dirty), wählt zwischen `MarkdownPreview`/`MarkdownSource`/Split, hält keinen eigenen Text-State (alles im Store). | `{ path: string }` |
| `MarkdownPreview` | `src/components/MarkdownPreview.tsx` | Render-Pipeline (`react-markdown` + remark/rehype, §0/§4). Ersetzt/erweitert das bestehende `Md` aus `MessageTimeline.tsx`. | `{ source: string; basePath: string; onWikiLink(name): void }` |
| `MarkdownSource` | `src/components/MarkdownSource.tsx` | CodeMirror-6-Quell-Editor (`@codemirror/lang-markdown`), Paste-Handler, Scroll-Sync-Emitter. Dünner React-Wrapper um eine `EditorView`. | `{ path: string; value: string; onChange(v): void; onScroll(ratio): void }` |
| `MarkdownToolbar` | `src/components/MarkdownToolbar.tsx` | Formatierungs-Buttons; ruft CodeMirror-Commands auf der aktiven `EditorView` auf. | `{ view: EditorView \| null }` |
| `mdPipeline.ts` | `src/mdPipeline.ts` (kein Component) | Single-Source der remark/rehype-Plugin-Arrays + Sanitize-Schema + Wikilink-Plugin. Importiert von `MarkdownPreview` **und** vom künftigen `Md` in `MessageTimeline.tsx` (Konsolidierung). | — |
| `cmMarkdown.ts` | `src/cmMarkdown.ts` (kein Component) | CodeMirror-Extension-Factory (`markdown({ base, codeLanguages })`, Theme, Keymap, Paste-DOM-Handler). Teilt die Theme-Factory mit [[07-file-explorer]]s `cmEditor.ts`. | — |

### 2.2 Mount-Punkt im bestehenden Layout

Aus der FRONTEND MAP: `.body` ist die innere Flex-Zeile (`.center` │ `<Inspector/>`). Der Editor mountet im **„Files"-View** in den `.center`-Slot (OE-38). In `src/App.tsx` wird das `.center`-Rendering view-abhängig:

```tsx
// src/App.tsx — schematisch, innerhalb .body
<div className="center">
  {activeView === "files" && selectedFilePath?.endsWith(".md")
    ? <MarkdownEditor path={selectedFilePath} />
    : activeView === "files"
      ? <CodeEditor path={selectedFilePath} />      // generisch, aus [[07-file-explorer]]
      : <><div className="center-title">Aktive Agenten</div><AgentGrid/></>}
</div>
```

`selectedFilePath` stammt aus dem Store (in [[07-file-explorer]] §3.1 eingeführt), `activeView` aus [[10-navigation-toolbar]]; §3 hier ergänzt nur die Markdown-spezifischen Felder. Die `.md`-Verzweigung (`.endsWith(".md")`) entscheidet, ob `MarkdownEditor` (mit Preview) oder der generische `CodeEditor` greift — beide auf demselben CodeMirror-Unterbau, der Editor unterscheidet sich nur in Pipeline + Toolbar.

### 2.3 Wiederverwendung & Konsolidierung

- `Md` in `MessageTimeline.tsx` (Z.12–35) nutzt heute `react-markdown` + `remark-gfm` ohne Sanitize/Highlight. **Es wird auf `mdPipeline.ts` umgestellt**, damit Chat-Markdown und Editor-Preview identisch (und gleich sicher) rendern. Das ist ein Edit an `MessageTimeline.tsx`, nicht ein Bruch.
- Der Paste-Handler übernimmt `blobToBase64` aus `Inspector.tsx` (Z.15–22) — am besten nach `src/format.ts` (oder neu `src/blob.ts`) gehoben und von beiden Stellen importiert, statt dupliziert.

---

## 3. State & Datenfluss

### 3.1 Store-Erweiterungen (`src/store.ts`)

Der Editor-Buffer ist UI-State (Working-Copy vor dem Save), gehört also in den Zustand-Store — nicht in die SSOT-Stores (Sidecar-Pool/`agents.json`/SQLite; Invariante 5). Diese Felder ergänzen die in [[07-file-explorer]] §3 eingeführten FS-Felder/Actions (`activeRoot`, `treeChildren`, `selectedFilePath`, `openFilePath(path)`) sowie `activeView` aus [[10-navigation-toolbar]] (dort lebt der View-State):

```typescript
// Ergänzungen an MadsState (src/store.ts)
type ViewMode = "preview" | "edit" | "split";

interface MadsState {
  // … bestehend …
  editorBuffers: Record<string, string>;   // path -> Working-Copy (vor Save); fehlt = noch nicht geladen
  editorDirty: Record<string, boolean>;    // path -> ungesicherte Änderungen
  editorViewMode: ViewMode;                 // global (eine .md offen zugleich, §1.1/OE-38), session-only (OE-36)
  editorSaving: Record<string, boolean>;    // path -> Save in flight (Doppel-Save/Race vermeiden)
  autosaveEnabled: boolean;                 // Default false (OE-37)
  diskMtime: Record<string, number>;        // path -> mtime beim letzten Load/Save (Konflikt-Check, §7)

  // Actions (Signaturen)
  setEditorBuffer(path: string, text: string): void;          // tippen → buffer + dirty=true
  setEditorViewMode(mode: ViewMode): void;
  saveFile(path: string): Promise<void>;                      // → Core mads_write_file
  revertFile(path: string): void;                             // buffer = zuletzt geladener Disk-Stand
  insertImageFromBlob(path: string, blob: Blob): Promise<void>; // schreibt Bild + fügt rel. Link ein
  setAutosaveEnabled(on: boolean): void;
}
```

### 3.2 Datenfluss (Lesen)

Anders als der NDJSON-Sidecar-Pfad (`agent_event` etc.) läuft FS **nicht** über die Sidecar-Pipe (die ist NDJSON-only, [[01-architecture]] §2.2; PROTOCOL MAP §0), sondern über die Tauri-Command-Bridge des Cores ([[07-file-explorer]] §4):

```
Klick auf .md (FileTree)
  → openFilePath(path)                   [Store-Action, 07 §3.2]
  → invoke("mads_read_file",{path})      [src/ipc.ts → Rust-Core]
  → Core: Scope-Check + read_capped → FileRead { text, mtime_ms, … }
  → editorBuffers[path] = text; diskMtime[path] = mtime_ms
  → MarkdownEditor rendert (Preview)
```

### 3.3 Datenfluss (Schreiben)

```
⌘S / Save
  → saveFile(path)
  → editorSaving[path]=true
  → invoke("mads_write_file",{path, content: editorBuffers[path], base_mtime_ms: diskMtime[path]})
  → Core: Scope-Check + canonicalize-prefix-check + SERVER-SEITIGER mtime-Vergleich (§7)
        ├─ mtime(Disk) > base_mtime_ms ⇒ Ok(WriteResult::Conflict) — KEIN Schreiben (kein silent clobber)
        └─ sonst: atomar schreiben ⇒ Ok(WriteResult::Saved { mtime_ms })
  → bei Saved:    editorDirty[path]=false; diskMtime[path]=mtime_ms; editorSaving[path]=false
  →               notice(?, "ok", "Gespeichert")  — Notice-Mechanik wie store.notice()
  → bei Conflict: editorSaving[path]=false; editorDirty bleibt true; Dialog (§7)
```

Die `notice`-Funktion existiert bereits (`store.ts`, FRONTEND MAP §2: „`notice(agentId,tone,text)`"); ein Save ist nicht agent-gebunden — entweder eine globale Toast-Notice (kleines neues UI) oder, wenn die Datei aus einem Sub-Worktree stammt, gegen dessen `agentId` gepusht. Empfehlung: leichte globale Save-Notice (Teil von OE-37/MVP).

> **Wichtige Grenze:** `editorBuffers` ist **niemals** die Wahrheit über den Disk-Inhalt — nur die Working-Copy. Der Disk-Stand ist Sache des Cores; bei `dirty=false` ist Buffer == zuletzt bekannter Disk-Stand. `git_status` (`behind/ahead/dirty` auf `AgentVM`) bleibt die Wahrheit über den git-Working-Tree-Zustand.

---

## 4. Protokoll- & Core-Anbindung

### 4.1 `shared/protocol.ts` — bewusst keine neuen Message-Typen

`shared/protocol.ts` ist die SSOT der **Sidecar-Nachrichten** (NDJSON über stdin/stdout). FS läuft **nicht** über die Sidecar — also **keine** Ergänzung am `HostMessage`/`SidecarMessage`-Union (Z.44–66 / Z.187–204). Das ist die korrekte Schicht-Wahl: der Core ist „Owner aller … IPC, Secrets, Persistenz" (CLAUDE.md) und FS ist dieselbe Trust-Klasse wie Prozesse/Secrets, also gehört es hinter die **Core-Command-Bridge**, nicht in die Sidecar-Pipe (deren stdout NDJSON-only ist).

Die **Typen** des FS-Vertrags (`DirNode` für Verzeichnis-Einträge, `FileRead` für das Lese-Resultat `{ text|bytesBase64, mtime_ms, truncated, kind }`, `WriteResult = Saved { mtime_ms } | Conflict`) werden in [[07-file-explorer]] §3/§4 definiert (geteilt mit dem generischen Editor). Falls sie in `shared/` leben sollen (damit Core-Rust-Mirror und Frontend dieselbe Form annehmen), gehören sie dorthin — der Markdown-Editor importiert sie, definiert sie nicht neu.

### 4.2 Core-Commands

Der Markdown-Editor **konsumiert** zwei der in [[07-file-explorer]] §4.2 definierten `#[tauri::command]`s (`mads_read_file`, `mads_write_file`) **verbatim** — exakt deren Signaturen, ohne Abweichung. Die Bild-Paste braucht zusätzlich **ein neues** Byte-Schreib-Command, das in 07 **nicht** existiert (07 liest Bild-Bytes über `read_capped` → `bytesBase64`, hat aber **keinen** Byte-Schreibpfad). `mads_write_file_bytes` ist damit die einzige FS-Command-Ergänzung dieses Dokuments über 07s Satz hinaus:

```rust
// src-tauri/src/files.rs
// — aus 07 §4.2 verbatim konsumiert (NICHT hier neu definiert):
#[tauri::command]
fn mads_read_file(state: State<FsScope>, path: String) -> Result<FileRead, String>;  // { text|bytesBase64, mtime_ms, truncated, kind }
#[tauri::command]
fn mads_write_file(state: State<FsScope>, path: String, content: String, base_mtime_ms: f64)
    -> Result<WriteResult, String>;  // WriteResult::Saved { mtime_ms } | WriteResult::Conflict — mtime-Check SERVER-SEITIG (07 §4.2)

// — NEU, eingeführt von Doc 08 (Bild-Paste, §1.2):
#[tauri::command]
fn mads_write_file_bytes(state: State<FsScope>, path: String, bytes: Vec<u8>, base_mtime_ms: f64)
    -> Result<WriteResult, String>;  // gleiche Conflict-Semantik wie mads_write_file
```

> **Wichtig (Cross-Doc):** `mads_write_file`s Conflict-Erkennung liegt **im Core** (07 §4.2: `base_mtime_ms`-Parameter → `WriteResult::Conflict` ohne Schreiben), **nicht** im Frontend. Der Editor übergibt `diskMtime[path]` als `base_mtime_ms` und verzweigt auf das `WriteResult` (§3.3, §7) — er macht **keinen** separaten Client-`stat`. So bleiben 07 und 08 auf **einer** Signatur und **einem** Conflict-Ort.

`mads_write_file_bytes` muss zu 07s Handler-Registrierung (`generate_handler!` in `lib.rs`) **und** zu `src-tauri/src/files.rs` **hinzugefügt** werden — ein geteilter Edit an `files.rs` + `lib.rs`, der dem Lockfile-/Shared-File-Protokoll unterliegt (oben, §4.3). 07s heutiger Block ist:

```rust
// src-tauri/src/lib.rs (Z.65–69, IST-Stand)
.invoke_handler(tauri::generate_handler![ start_sidecar, sidecar_send, stop_sidecar ])
// 07 ergänzt: + mads_read_dir, mads_read_file, mads_write_file, mads_register_root
// 08 ergänzt zusätzlich: + mads_write_file_bytes
```

Der Core bleibt **dünn**: Scope-Check + `canonicalize`-Prefix-Check + Server-mtime-Vergleich + `std::fs`/`tokio::fs`, sonst nichts. Keine Markdown-Logik im Core (die ist reine UI).

### 4.3 fs-Capability (gescoped)

Die fs-Capability (`src-tauri/capabilities/fs.json` inkl. `fs:scope` mit Deny-Vorrang für `.git`/`.env*`/`.ssh`/`.aws`/`node_modules`/`target`, plus `requireLiteralLeadingDot: true` in `tauri.conf.json`) ist **vollständig** in [[07-file-explorer]] §4.3 / TAURI FS TECH BRIEF §1 spezifiziert — **eine** Quelle, hier nicht reproduziert (eine zweite Kopie würde divergieren). Der Markdown-Editor fügt **nichts** hinzu: in 07s Modell laufen Lesen **und** Schreiben über die mads-eigenen Commands (`mads_read_file`/`mads_write_file`/`mads_write_file_bytes`, §4.2), **nicht** über die Plugin-Built-ins — die fs-Plugin-Capability deckt nur `fs:allow-watch` (Live-Reload). Es braucht also **kein** zusätzliches `fs:*`-Recht für Save, und der mtime-Konfliktcheck ist server-seitig im Command (07 §4.2), nicht ein Client-`stat`.

Die **Laufzeit-Scope-Erweiterung** für den arbiträr gewählten `repoRoot` (`app.fs_scope().allow_directory(repoRoot, true)`) erfolgt beim `mads_register_root` / `setActiveRoot` (nach Projektauswahl) und ist Sache von [[07-file-explorer]] §4. Aktuelle Capability heute (`src-tauri/capabilities/default.json`) hat **kein** `fs:*` — `fs.json` kommt durch das Datei-Feature neu hinzu.

> **Wichtig (Lockfile-Achse):** `tauri-plugin-fs` (Cargo.toml + Cargo.lock) und `@tauri-apps/plugin-fs`/CodeMirror-Pakete (package.json + package-lock.json) sind geteilte Datei-Edits → paix Land-first/Single-owner-Protokoll (CLAUDE.md „Build & Gates"). Wird gemeinsam mit [[07-file-explorer]] gelandet, nicht doppelt.

---

## 5. Sicherheit & Schicht-Grenzen

Diese Sektion zitiert die Invarianten und zeigt, dass keine gebrochen wird.

### 5.1 Schicht-Grenze (CLAUDE.md §„Schichten", verbatim)

> **`src/`** — React/TS-Frontend. Reines UI: rendert State, sendet User-Intent. **Keine** Prozesse, **keine** Secrets, **keine** git/gh-Ausführung.

Der Editor liest/schreibt **nie** direkt — jeder FS-Zugriff geht durch den Rust-Core (`mads_read_file`/`mads_write_file`), der den einzigen, auditierbaren Choke-Point bildet ([[01-architecture]] §2.2; TAURI FS BRIEF §5). Die Sidecar bleibt aus dem FS-Pfad (ihr stdout ist NDJSON-only). Damit ist `src/` rein, der Core dünn (nur Scope/Policy + `std::fs`), die Sidecar unberührt.

### 5.2 Untrusted-/agent-/PR-geschriebenes Markdown — keine Script-Ausführung

`.md`-Dateien können von Sub-Agenten oder aus PRs stammen (Koordinations-Artefakte, [[06-ownership-and-coordination]]). Render-Sicherheit:

- **`rehype-sanitize` als letztes rehype-Plugin** (nach `rehype-starry-night`), mit einem von `defaultSchema` abgeleiteten Schema, das nur die starry-night-`pl-*`-Span-Klassen, Task-List-/Footnote-Attribute und `id` (für Heading-Anchors) zulässt:

```typescript
// src/mdPipeline.ts — Sanitize-Schema
import { defaultSchema } from "rehype-sanitize";
export const mdSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    span: [...(defaultSchema.attributes?.span ?? []), ["className", /^pl-/]],
    "*": [...(defaultSchema.attributes?.["*"] ?? []), "id"],
  },
  // protocols für href bleibt defaultSchema (http/https/mailto) — alles andere wird gestrippt
};
```

- `react-markdown` ist per Default XSS-sicher (kein `dangerouslySetInnerHTML`); Sanitize fängt das Risiko ab, das Plugins/`urlTransform` wieder einführen könnten (REACT UI BRIEF). **Kein `rehype-raw`** (kein roher HTML-Durchlass).
- Codeblöcke werden nur **highlightet** (statische `pl-*`-Klassen), nie ausgeführt. `mermaid` (falls je) wäre ein bewusster `components.code`-Override, lazy, sandboxed — Post-MVP, nicht im sanitisierten Pfad.

### 5.3 Pfad-Sicherheit (Traversal, Symlink-Escape)

- **Capability-Scope** (§4.3): `deny` schlägt `allow` (Deny-Precedence, TAURI FS BRIEF §1), `.git`/`.env*`/`.ssh`/`.aws` sind hart gesperrt → **Secrets nie lesbar/schreibbar** vom Editor.
- **Laufzeit-Gate im Core** (die eigentliche Grenze, TAURI FS BRIEF §5): jeder `path` wird `canonicalize()`d und muss Prefix-Nachfahre von `project.repoRoot` **oder** `~/mads-worktrees/<repo>/<agentId>` sein — sonst Reject. Das schlägt Symlink-Escape und `..`-Traversal über die statische Glob-Capability hinaus.
- `tauri-plugin-fs` blockt zusätzlich literale `..`-Parent-Accessor zur Laufzeit (PROTOCOL MAP §4a).
- **Bild-Paste schreibt nur** in `<dir>/assets/` **relativ zur geöffneten Datei** (also im selben Working-Tree) — derselbe Scope-Check, keine Ausnahme.

### 5.4 Link-Sicherheit

- **Wikilinks** (`[[name]]`) werden ausschließlich auf `./<name>.md` **innerhalb desselben Verzeichnisses** (oder relativ aufgelöst) abgebildet und über `openFile` geöffnet — nie als externe URL interpretiert.
- **Externe Links**: heute öffnet `Md` jeden `href` direkt via `openUrl` (`MessageTimeline.tsx` Z.18–28). Für agent-/PR-Inhalt wird das verschärft: `https`-Links direkt, **alles andere** (`http`, `file:`, custom schemes) nur nach **Bestätigungs-Dialog** (paix-Invariante 4: außen-sichtbare Aktionen explizit). Der volle Ziel-URL wird im Dialog gezeigt.

### 5.5 Invarianten-Check (Merge/Branch/State)

Speichern erzeugt **nie** Commit/PR/Merge (Invariante 1 — nur der Integrator merged; Subs schlagen PRs vor). CI/`main` bleiben unberührt (Invariante 2). Editor-State (`editorBuffers`) ist reiner UI-Mirror, **nicht** die SSOT — die bleibt Sidecar-Pool/`agents.json`/SQLite + git-Working-Tree (Invariante 5). Ein Sub-Worktree wird nur über seinen eigenen Pfad editiert — nie greift der Editor in den Worktree eines anderen Streams (Invariante 3).

---

## 6. Performance & Skalierung

- **CodeMirror 6 virtualisiert** den Quell-Editor von Haus aus (nur sichtbare Zeilen im DOM) — große `.md` (mehrere tausend Zeilen Design-Doc) bleiben flüssig. Das ist der Hauptgrund für CodeMirror statt `<textarea>` (REACT UI BRIEF: CodeMirror serviert 07/08/09 mit einem ~50–300 KB Stack vs. Monaco 2–5 MB).
- **Preview-Render** ist eine reine Funktion des Quell-Strings; im Split-Modus wird sie **debounced** (≈120 ms nach letztem Tastendruck) neu gerendert, statt pro Keystroke — sonst rendert `react-markdown` bei jedem Zeichen den gesamten AST neu.
- **Scroll-Sync** koppelt Editor- und Preview-Scroll über ein gemeinsames Verhältnis (`scrollTop/scrollHeight`), gecoalesct via `requestAnimationFrame` — keine Event-Schleife.
- **Lazy-Load der schweren Pipeline-Teile**: `rehype-starry-night` (600+ Grammatiken) und ein eventuelles `mermaid` werden dynamisch importiert (`await import(...)`), damit der Streams-Default-View nicht belastet wird.
- **Caps & Logging statt stillem Truncate** (Doc-Set-Konvention): Dateien über einer Größe (Vorschlag **2 MB**) öffnen read-only mit Banner „Datei zu groß zum Editieren — schreibgeschützt" statt geladen+stumm abgeschnitten zu werden. Der Cap wird **geloggt** (`debugLog`, das vorhandene stderr-/bad-json-Log, FRONTEND MAP §2) und im UI sichtbar gemacht. Analog zur `MessageTimeline`-Idiom-Klammer (Output > 400 Zeichen → „mehr anzeigen", `MessageTimeline.tsx` Z.39/60) wird auch hier nie ohne Hinweis gekappt.
- **`editorBuffers` ist pro Pfad** und überlebt View-Wechsel (wie `drafts`/`draftImages` in `store.ts`); kein Re-Read beim Zurückschalten auf eine bereits geöffnete dirty Datei.

---

## 7. Edge-Cases & Fehlerzustände

| Fall | Verhalten |
|---|---|
| **Datei auf Disk geändert** (Agent/Git schreibt, während offen) | `saveFile` ruft `mads_write_file(path, content, base_mtime_ms: diskMtime[path])`; der **Core** vergleicht die Disk-`mtime` server-seitig (07 §4.2) und gibt `Ok(WriteResult::Conflict)` zurück, **ohne** zu schreiben → **kein stiller Clobber** (07 §7, TAURI FS BRIEF §5). Bei `Conflict` zeigt der Editor den Dialog „Datei wurde extern geändert — Überschreiben / Neu laden / Abbrechen" (kein separater Client-`stat`). |
| **Save schlägt fehl** (Scope-Reject, Permission, IO) | Core liefert `Err(String)` (vom `Conflict`-Fall zu unterscheiden, der ein erfolgreiches `Ok(WriteResult::Conflict)` ist); `editorSaving=false`, `editorDirty` bleibt `true`, Notice `err` mit Grund. Nie „gespeichert" vortäuschen. |
| **Datei zu groß** (> Cap) | read-only Banner (§6), Edit/Split deaktiviert. |
| **Binär/Nicht-UTF-8 als `.md` getarnt** | `read_to_string` schlägt fehl oder liefert Ersatzzeichen → read-only + Hinweis. |
| **Wikilink-Ziel fehlt** | Link „rot"/gestrichelt, Tooltip „Datei nicht gefunden"; Klick legt sie **nicht** automatisch an (kein FS-Seiteneffekt ohne Intent). |
| **Externer Link, non-https** | Bestätigungs-Dialog (§5.4). |
| **Bild-Paste, `assets/` fehlt** | Core legt Verzeichnis an (`mkdir -p`-Äquivalent, scope-gecheckt) vor dem Schreiben. |
| **Editor offen, Stream wird gestoppt + Worktree entfernt** (`stopAgent(id,true)`) | Pfad nicht mehr in-scope/existent → nächster Save scheitert sauber (Notice), Banner „Worktree entfernt". Editor verwaist nicht still. |
| **Datei im Worktree, der von einem anderen Stream besessen ist** | Vor/nach Save Cross-Check gegen `collisions`/`detectTrespass` (geteilte `shared/`-Logik); roter Hinweis „Datei gehört Stream X (`reason`)" — Speichern bleibt erlaubt (lokaler Working-Tree), die Kollision sichtbar in [[09-change-overview]]. |
| **Doppel-Save (Race)** | `editorSaving[path]`-Flag blockt parallelen zweiten Save. |
| **Unmount mit Dirty** | Buffer bleibt im Store (Pfad-keyed); beim Wieder-Öffnen ist der ungesicherte Stand da (wie `drafts`). |

---

## 8. Barrierefreiheit & Tastatur

- **CodeMirror 6** bringt vollständige Tastatur-Editierung + ARIA-Textbox-Semantik out of the box.
- **Shortcuts** (CodeMirror-Keymap + Editor-Header):

  | Aktion | Shortcut |
  |---|---|
  | Speichern | `⌘S` |
  | Edit ⇄ Preview umschalten | `⌘⏎` |
  | Bold / Italic | `⌘B` / `⌘I` |
  | Heading-Stufe | `⌘1`…`⌘3` |
  | Link einfügen | `⌘K` |
  | Bild einfügen (Paste) | `⌘V` (Clipboard-Bild) |

- **Segmented Control** (Preview/Edit/Split) ist tab-/pfeil-navigierbar (`role="tablist"`/`role="tab"`, `aria-selected`).
- **Toolbar-Buttons** mit `aria-label` (analog Composer-Buttons in `Inspector.tsx` Z.201/215, die bereits `aria-label`/`title` setzen).
- **Fokus-Management**: Umschalten auf Edit/Split setzt Fokus in die `EditorView`; Umschalten auf Preview gibt Fokus an den Container (kein Fokus-Verlust ins Nichts).
- **Preview-Links** sind echte `<a>` mit `onClick`-Override (wie heute in `Md`) — tastatur-fokussierbar, `Enter` löst aus.
- **Dirty-Status** wird zusätzlich textuell exponiert (`aria-label` am Titel „ungespeichert"), nicht nur über die `●`-Farbe.

---

## 9. Tests

Vitest-Stil wie im Repo (`shared/collision.test.ts`, `shared/ownership.test.ts`). Reine Funktionen werden Unit-getestet, die Komponenten integrations-getestet (jsdom).

**Unit (rein, `src/`-Logik & Pipeline):**
- `mdPipeline.ts` — Wikilink-Plugin: `[[04-sub-agents]]` → `link`-Node `./04-sub-agents.md`; `[[name with space]]` → korrekte Auflösung; `[[a]] und [[b]]` in einem Text-Node → zwei Links.
- Sanitize-Schema: `<script>`/`onerror`/`javascript:`-href werden gestrippt; `pl-*`-Spans und Heading-`id` überleben; Tabelle/Task-Liste/Footnote/Strikethrough (GFM) bleiben.
- Bild-Paste-Helper: `blobToBase64`/Bytes-Pfad erzeugt deterministischen relativen Link-String; Pfad-Bildung `<dir>/assets/<name>` ohne `..`.
- Cap-Logik: Datei > Cap ⇒ read-only-Flag + Log-Eintrag (kein stilles Truncate).

**Integration (Komponenten, gemockter Core via `invoke`-Mock):**
- `MarkdownEditor`: Öffnen → Preview rendert; Umschalten → CodeMirror; Tippen → `editorDirty=true`; `⌘S` → `mads_write_file` aufgerufen mit Buffer-Inhalt; bei `Err` bleibt dirty + Notice `err`.
- mtime-Konflikt: stat ≠ `diskMtime` ⇒ Dialog statt direktem Save.
- Externer non-https-Link ⇒ Bestätigungs-Dialog, kein direkter `openUrl`.
- Scope-Reject (Core liefert Fehler) ⇒ kein „gespeichert", korrekte Fehler-Notice.

**Store:** `setEditorBuffer`/`saveFile`/`revertFile`/`insertImageFromBlob` als Store-Unit-Tests (Zustand-Store ist direkt testbar wie die bestehenden Actions).

---

## 10. Roadmap

Eingeordnet in die **Sub-Phasen aus [[07-file-explorer]] §10** (P-FE-a/-b/-c), da der Markdown-Editor **abhängig von 07** ist (fs-Core-Commands, CodeMirror-Stack); konform zu OE-3 („MVP = ein Fenster"). Der Render-Pfad landet eine Phase **vor** Edit/Save — genau wie 07 die Vorschau in P-FE-a und den Schreibpfad in P-FE-b sequenziert.

| Phase | Inhalt (08) |
|---|---|
| **P-FE-a** (mit 07s read-only Tree+Vorschau) | **Preview-Modus**: `react-markdown` + `remark-gfm` + `rehype-starry-night` + `github-markdown-css` + `rehype-sanitize`, GFM voll, Heading-Anchors, Wikilink-Auflösung, sichere externe Links. `Md` in `MessageTimeline.tsx` auf `mdPipeline.ts` konsolidiert. Größen-Cap mit Banner / read-only-Fallback. |
| **P-FE-b** (mit 07s Editor + `mads_write_file`/mtime-Conflict) | **Edit-Modus**: CodeMirror 6 (`@codemirror/lang-markdown`), `⌘S`-Save über Core, Dirty-State, Revert; Formatierungs-Toolbar (bold/italic/heading/list/link/code) + Shortcuts; **Bild-Paste** (`mads_write_file_bytes`) → Repo + relativer Link; server-seitiger mtime-Konfliktschutz (07 §4.2). |
| **Post-MVP** | Split-Modus mit Scroll-Sync (MVP genügt Edit/Preview-Toggle); Autosave (debounced, opt-in; OE-37); TOC-Seitenleiste/Outline aus Headings; `mermaid`-Fences (lazy, sandboxed `components.code`-Override); Tabellen-Editor-Komfort (Spalten ausrichten), Footnote-Insert-Helfer. |

> **WYSIWYG** (Milkdown/TipTap) — **nur erwähnt**, bewusst nicht gewählt: kann den reinen Code-/Quell-Editor aus [[07-file-explorer]] nicht mitbedienen und verbirgt den rohen Markdown-Quelltext (REACT UI BRIEF). Höchstens als optionaler dritter Modus weit nach MVP.

---

## 11. Offene Fragen (für den Review)

Neue OEs dieses Dokuments (Bereich Doc 08, Range OE-36..OE-40), gespiegelt in READMEs konsolidierter Liste unter `### Markdown-Editor (Doc 08)`. **Follow-up (mit dem 07–10-Batch zu landen):** README-Index-Tabelle (Doc-08-Zeile + Doc-Anzahl/Heading), die OE-36..40-Gruppe und die Glossar-Einträge (`Markdown-Editor`/`editorBuffers`/`mdPipeline`) sind hier bereits gesetzt; bleiben die Geschwister-Docs 07/09/10 noch ausstehend, ist der README-Stand bis zu deren Landung partiell.

✅ **ENTSCHIEDEN — Default-View** (§1.1, **OE-36**): `.md` öffnet im **Preview**-Modus; zuletzt gewählter Modus session-only gemerkt (`editorViewMode`), nicht persistiert (OE-3).

> **OFFENE FRAGE (Autosave, OE-37):** Autosave default **aus**; explizites `⌘S`. Offen, ob Autosave (debounced 1500 ms) opt-in im MVP oder Post-MVP kommt — und ob Save-Feedback eine globale Toast-Notice braucht (heute ist `notice` agent-gebunden).

> **OFFENE FRAGE (Panel-Platzierung, OE-38):** Editor im `.center`-Slot (Inspector bleibt sichtbar; Empfehlung) **oder** breites `.body`-Panel (mehr Schreibfläche, Inspector verdeckt)?

> **OFFENE FRAGE (Bild-Paste-Zielverzeichnis, OE-39):** Bilder nach `<dir>/assets/` relativ zur Datei (Empfehlung) **oder** ein repo-weites `docs/assets/`/`.attachments/`? Und Namensschema (`<ts>-<n>` vs. Content-Hash zur Dedup)?

> **OFFENE FRAGE (Größen-Cap, OE-40):** Read-only-Schwelle bei **2 MB** (Vorschlag) — Wert zu kalibrieren; Cap muss geloggt + im UI sichtbar sein (nie stilles Truncate).

---

## 12. Querverweise

- [[07-file-explorer]] — Eltern-Feature: CodeMirror-6-Stack, `mads_read_file`/`mads_write_file` (verbatim konsumiert), fs-Capability/Scope, `openFilePath`/`activeRoot`/`treeChildren`/`selectedFilePath`-Store-Felder. `mads_write_file_bytes` (Bild-Paste) ist die einzige FS-Command-Neuerung dieses Doks. `activeView` lebt in [[10-navigation-toolbar]]. (Dieses Dok ergänzt nur den `.md`-Spezialfall.)
- [[09-change-overview]] — teilt CodeMirror 6 + `@codemirror/merge`; ein gespeichertes un-committetes `.md` erscheint dort als `dirty`; gemeinsame `shared/`-Kollisions-/Trespass-Logik (§7).
- [[06-ownership-and-coordination]] §§4–5 — die editierten Koordinations-Artefakte/Ownership-Docs; deren `[[wikilinks]]`/Regel-Tabellen rendert §0/§5.
- [[02-dashboard]] §2 — `.app`/`.body`-Layout und CSS-Variablen, an denen der Editor mountet/theme't.
- [[01-architecture]] §2.2 — Schicht-„Darf NICHT"-Tabelle, Begründung des FS-via-Core-Pfads.
- [[tauri2-stack]] — Versions-/Plugin-Verifikation (`tauri-plugin-fs`, Capabilities).
- [[macos-design]] — HIG-Konventionen (Segmented Control, Dirty-`●`, Light/Dark folgt OS).
