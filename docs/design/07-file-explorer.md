# 07 — Datei-Explorer & In-App-Editor (mads)

> Status: Design, implementierungsreif. Stand: 2026-06-22.
> Sprache: Deutsch (Code/Identifier englisch).
> Quellen: [[tauri2-stack]] (Capabilities/Plugin-Modell), [[macos-design]] A.0–A.5
> (Content/Inspector-Material, Vibrancy-Caveats), [[10-navigation-toolbar]] (LAYOUT-CONTRACT:
> kein persistentes Sidebar, Explorer mountet im Primary-Panel-Mittel-Slot, eigener
> Stream-Kontext-Selector), [[_paix-multi-agent-reference]] §3/§6 (Worktree-Isolation,
> Region-Disziplin). Versionsbezüge (`tauri-plugin-fs`, CodeMirror 6, `react-markdown`,
> `react-arborist`) sind gegen die installierten Pakete zu verifizieren.

---

## 0. Zusammenfassung & Einordnung

Dieses Dokument spezifiziert die **Folder-/Datei-Sicht** von mads: einen lazy-geladenen,
virtualisierten **Verzeichnisbaum** **eines wählbaren Streams** — wahlweise des Haupt-Checkouts
`repoRoot` (main / Integrator) **oder eines beliebigen aktiven Sub-Agent-Worktrees**
(`~/mads-worktrees/<repo-slug>/<agentId>`) — plus einen **Content-Bereich** für **Vorschau**
(Markdown über den GitHub-Style-Renderer aus [[08-markdown-editor]], Code syntax-highlighted, Bilder,
Binär-Fallback) und **In-App-Editor** (CodeMirror 6 für Code, MD-Editor aus [[08-markdown-editor]]
für Markdown). Es ist die erste mads-Funktion, die **direkten Datei-Zugriff** braucht — und genau
deshalb der härteste Schicht-Test: das Frontend darf **nicht** an die Platte. Aller Datei-Zugriff
läuft **durch den Rust-Core** (capability-gescoped, `tauri-plugin-fs` + ein dünner Satz
mads-eigener Commands), niemals aus dem Webview heraus und niemals über den Sidecar-NDJSON-Kanal.

**Der zentrale Use-Case dieses Docs: Sub-Agent-Arbeit inspizieren UND editieren — nicht nur `main`.**
Schreibt ein Sub-Agent eine neue `.md`-Datei, liegt sie in **seinem** Worktree und ist **noch nicht
auf `main`**. Der Mensch muss sie trotzdem reviewen können: er **wählt im Explorer-Header den
Kontext** (welcher Stream?) → die Datei erscheint im Baum **dieses** Streams → ein Klick öffnet sie
im Markdown-Editor ([[08-markdown-editor]]) → er liest, **editiert und speichert sie zurück in genau
diesen Worktree**. Der **Stream-Kontext-Selector** ist daher die **primäre, immer sichtbare**
Steuerung des Explorers (§1.2/§1.3), nicht ein optionaler Zusatz: er beantwortet „wessen Dateien
sehe ich gerade an?" über das Stream-Label + den `StatusDot`-Farbton ([[02-dashboard]] §3.2).

Der Explorer ist **read-mostly mit gegated, aber regulärem Edit** — und Edit gilt **in jedem
gewählten Stream**, einschließlich Sub-Agent-Worktrees (OE-35 entschieden, §11): er liest beliebige
Stream-Dateien und schreibt explizit (`mads_write_file`, capability-gescoped, mtime/hash-geprüft) in
**denselben** Worktree, den der Baum gerade zeigt. Er respektiert dabei die Koordinations-Disziplin
aus [[06-ownership-and-coordination]]: editiert der Mensch eine Datei, die ein **anderer** Stream
gerade **besitzt** (Region-Ownership-Trespass), warnt mads sichtbar (rot, §5.3). Das bloße Editieren
**im** Worktree des gewählten Streams ist dagegen **kein** Trespass, sondern der Normalfall — die
Worktree-Leiste (§5.3) ist dann **informativ** („du editierst in Stream X; landet erst mit dessen
PR auf `main`"), kein Blocker.

**Restate der drei paix-Invarianten (dieses Dok berührt Branch-/Worktree-/Datei-Zustand):**

1. **Only `main` merges** — der Explorer **merged nie**. Menschliche Edits landen als ganz
   normale Änderung im jeweiligen Worktree; der Weg nach `main` bleibt der Integrator-Merge
   ([[03-main-agent]]). Der Explorer schreibt Dateien, **nicht** Refs.
2. **`main` is always runnable** — der Explorer ändert **nie** die git-Mechanik; ein gespeicherter
   Edit ist eine uncommittete Änderung (`dirty`), die durch dieselben Gates muss wie jede andere
   ([[06-ownership-and-coordination]] §5, Quality-Gate).
3. **Subs never self-merge / outward-visible actions are explicit** — `write_text_file` ist eine
   lokale Disk-Aktion, **keine** außen-sichtbare (kein push/PR/merge). Schreibvorgänge sind
   explizit (Save-Aktion des Menschen), nie automatisch.

| Dokument | Beziehung |
|---|---|
| [[08-markdown-editor]] | Liefert den **Renderer** (GitHub-Style, `react-markdown`-Pipeline) und den **MD-Editor**, die der Content-Bereich für `.md`-Vorschau/-Edit einbettet |
| [[09-change-overview]] | **Komplementär:** 09 *zeigt* live (read-only), **welche** Dateien jeder Stream gerade ändert (Diff-Panes, nach Stream gruppiert); der Explorer **öffnet/editiert** dieselben Dateien **pro Stream**. Beide nutzen **dieselbe Stream-Identität** — der Root-/Kontext-Selektor des Explorers und der Pane-Key `${agentId}::${path}` von 09 listen Streams identisch aus `order.map(id => agents[id])` mit `selectedId` als Quelle und `StatusDot`/`STATUS_META` als Farbcode. Geteilt außerdem der **Region-/Diff-Datenfluss** (`tool_use`-Edit-Payloads, `ChangedRegion`, `Collision`) und die `mads-fs`-Capability + `mads_read_file`; der Explorer markiert „auf Disk geändert" & „von Agent X bearbeitet"; das **Browsen und Editieren von Sub-Agent-Worktrees** ist der gemeinsame Brücken-Use-Case (review, bevor ein PR landet) |
| [[06-ownership-and-coordination]] | `detectTrespass`/`OwnershipRule`/`Collision` liefern die **Trespass-Warnung** beim Edit einer Datei, die ein **anderer** Stream besitzt (rot, §5.3) — der Edit im **eigenen** gewählten Worktree ist davon unberührt |
| [[10-navigation-toolbar]] | Der **Einstiegspunkt**: das Icon „Dateien" in der Activity-Rail aktiviert `activeView==="files"`; `activeView`/`PrimaryPanel`-State lebt dort. Die Rail führt **keine** persistente Stream-Liste mehr — der Explorer bringt seinen **eigenen** Stream-Kontext-Selector mit (§1.2, [[10-navigation-toolbar]] LAYOUT-CONTRACT (c)) |
| [[02-dashboard]] | Layout-Geschwister: die `.app`-Reihe ist **Rail \| Primary-Panel \| Main** — es gibt **keine** persistente Sidebar mehr ([[10-navigation-toolbar]] §1a, [[02-dashboard]] §2). Bei `activeView==="files"` mountet der Explorer als **Mittel-Spalte** (Primary-Panel-Slot, im Streams-View leer) **zwischen** Rail und `.main`; `.main` (Titlebar + `.body` mit `AgentGrid`+`Inspector`) bleibt **unverändert** stehen |
| [[01-architecture]] | Schicht-Invarianten (Frontend pur, Core besitzt I/O), Capability-Modell, IPC-Topologie |

Neue Typen: `shared/protocol.ts` (**keine** für den FS-Pfad — siehe §4: FS läuft über
Tauri-Commands/Plugin, nicht über NDJSON; nur ein optionaler `external_change`-Hinweis-Pfad ist
event-getragen). Neuer Rust-Code: `src-tauri/src/files.rs`. Neue Komponenten: `src/components/FileExplorer.tsx`,
`FileTree.tsx`, `FilePreview.tsx`, `FileEditor.tsx`.

---

## 1. UX & Interaktionsdesign

### 1.1 Zustände

| Zustand | Auslöser | Anzeige |
|---|---|---|
| **collapsed** | `activeView !== "files"` ([[10-navigation-toolbar]]) | Panel ausgeblendet; nur das Rail-Icon „Dateien" sichtbar |
| **tree, no selection** | Panel geöffnet, keine Datei gewählt | Verzeichnisbaum links; Content-Bereich zeigt Empty-State („Datei auswählen") |
| **preview** | Klick auf eine Datei | Content-Bereich rendert je Typ (Markdown / Code-Highlight / Bild / Binär-Fallback) |
| **edit** | „Bearbeiten" auf der Vorschau | CodeMirror 6 (Code) bzw. MD-Editor aus [[08-markdown-editor]] (Markdown) |
| **dirty** | ungespeicherte Änderung | `●`-Marker am Datei-Tab + Tree-Knoten; Save-Button aktiv |
| **saved** | erfolgreicher `write_text_file` | `●`-Marker weg; kurzer „gespeichert"-Hinweis |
| **conflicted** | Disk-Signatur (mtime, size, content-hash) ≠ geladene Signatur beim Save | Sheet „Auf Disk geändert" mit `[Disk laden]` / `[Meine Version überschreiben]` |
| **external-changed** | fs-watch (`watchImmediate`) meldet Änderung an geöffneter Datei — z.B. der Stream schreibt sie **gerade** weiter | Banner „auf Disk geändert · [Neu laden]" über dem Editor (§5.3-Caveat: bei aktivem Stream den Stream pausieren oder im Leerlauf editieren) |
| **in-worktree (informativ)** | gewählter Kontext = ein Sub-Agent-Worktree (Normalfall beim Review) | **blaue/neutrale Info-Leiste** (§5.3): „Du editierst in Stream X · landet erst mit dessen PR auf `main`" — **kein** Blocker |
| **owned (Trespass)** | geöffnete Datei = Region, die ein **anderer** Stream besitzt | **rote** Warnleiste (§5.3), Befund (Datei · Symbol · Owner-Stream) — beratend, nicht blockierend |
| **error** | I/O- oder Scope-Fehler aus dem Core | Inline-Fehlerzeile (kein Modal); Datei bleibt read-only |

### 1.2 Flows

- **Stream-Kontext wählen (primärer Flow):** Der **Stream-Kontext-Selector** im Explorer-Header
  (§1.3) ist die **erste** Steuerung. Er listet `main / Integrator` (→ `project.repoRoot`) **plus
  jeden aktiven Sub-Agent** (`order.map(id => agents[id])`, je Eintrag `StatusDot` + `label`), und
  setzt `activeRoot`. Default = der gerade selektierte Stream (`selectedId`), sonst `main`. Wahl →
  `setActiveRoot(...)` registriert den Root im Core (`allow_directory`, §4.2) und lädt die
  Top-Level-Ebene. Der Header liest dann „wessen Dateien sehe ich gerade an?".
- **Browsen → Vorschau:** im gewählten Kontext Baum (lazy, virtualisiert) → Klick auf Knoten →
  `mads_read_file` via Core → Typ-Erkennung → Vorschau. **Kein** Auto-Edit.
- **Sub-Agent schreibt neue `.md` → Review & Edit (Kern-Use-Case, end-to-end):**
  1. Stream X erzeugt `docs/notes/plan.md` in seinem Worktree (`~/mads-worktrees/<slug>/X`); die
     Datei ist **nicht** auf `main` und im `main`-Baum nicht sichtbar.
  2. Der Mensch wählt im Kontext-Selector **Stream X** → `activeRoot = {kind:"worktree", agentId:"X", …}`.
  3. `plan.md` erscheint im Baum **dieses** Streams (ggf. mit `⬤ agent`-Marker, §5.3).
  4. Klick → `openFilePath` → Markdown-Editor ([[08-markdown-editor]]) im Preview; eine **blaue
     Info-Leiste** sagt „Stream X · noch nicht auf `main`" (§5.3) — kein Blocker.
  5. „Bearbeiten" → der Mensch ändert den Inhalt → `Cmd+S` → `mads_write_file` schreibt **in Stream X'
     Worktree** zurück. Die Änderung wandert über den **normalen Weg** nach `main`: Stream X' PR →
     Integrator-Merge ([[03-main-agent]]) — der Explorer merged **nie** selbst.
- **Vorschau → Edit → Save:** „Bearbeiten" lädt den Editor-Buffer; `Cmd+S` ruft `mads_write_file`
  (Core, in den **aktiven** Root) → `saved`. Bei Disk-Drift (mtime/size/hash) → `conflicted`-Sheet
  (kein silent clobber).
- **Live-Reload / nebenläufiger Agent-Write:** Schreibt der gewählte Stream die offene Datei
  **gleichzeitig** → `watchImmediate` → `external-changed`-Banner → `[Neu laden]` (verwirft lokal nur
  nach Bestätigung, falls `dirty`). Praktischer Hinweis: gleichzeitiges Editieren durch Mensch **und**
  aktiven Agent kann kollidieren — **Empfehlung: den Stream pausieren** (`interrupt_agent`,
  [[02-dashboard]] §9.1) **oder im Leerlauf editieren**; der mtime/size/hash-Check beim Save ist die
  zweite Verteidigungslinie (§4.2/§7).
- **Worktree verschwindet:** wird Stream X gestoppt (`removeWorktree`), wird `activeRoot` ungültig →
  Fallback auf `main` + Hinweis (§7).

### 1.3 Layout (macOS-HIG, ASCII-Skizze)

**Keine persistente Sidebar mehr.** Die `.app`-Reihe ist **Rail | Primary-Panel | Main**
([[10-navigation-toolbar]] §1a, [[02-dashboard]] §2): die alte 232px-Stream-`Sidebar` ist aufgelöst
(ihre Stream-Liste war redundant mit dem `AgentGrid`). Bei `activeView === "files"` mountet der
Explorer als **Mittel-Spalte** (der Primary-Panel-Slot, der im Streams-View **leer** ist) **zwischen**
der Activity-Rail und `.main`. Er **ersetzt nichts** in `.main`: `.center` (`AgentGrid`) und
`<Inspector/>` bleiben rechts stehen und sichtbar (LAYOUT-CONTRACT (a)/(f)).

Innen ein klassisches **Master-Detail** (Baum | Content) mit einem **Stream-Kontext-Selector als
Panel-Header** — der primären, immer sichtbaren Steuerung (§1.2). Weil es **keine** persistente
Stream-Liste mehr gibt, an der ein Panel passiv ablesen könnte, **bringt der Explorer seinen eigenen
Selector mit** (LAYOUT-CONTRACT (c)), gespeist aus `order.map(id => agents[id])`, gebunden an
`selectedId`/`selectAgent`. HIG: Sidebar-Material für den Baum, **opaker** Content (Lesbarkeit,
[[macos-design]] A.5).

```
┌────┬───────────────────────────────────────────────┬───────────────────────────────┐
│ A  │  FILE EXPLORER (Primary-Panel, activeView=files)│  CONTENT (.main, bleibt)      │
│ C  │  ┌─ ◐ Stream „payments" (worktree) ▾ ─────────┐ │  ┌ .titlebar ───────────────┐ │
│ T  │  │   Kontext: ◆ main · ◐ payments · ◑ mail …  │ │  │ Dashboard · 6 agents …   │ │
│ I  │  └────────────────────────────────────────────┘ │  └──────────────────────────┘ │
│ V  │  ┌──────────────────┬──────────────────────────┐│  ┌ .body ──────────────────┐ │
│ I  │  │ [⌕ filter…]      │ plan.md          ● dirty ││  │ .center      │ Inspector │ │
│ T  │  │ ▾ docs/          │ ┌──────────────────────┐ ││  │ (AgentGrid)  │ timeline  │ │
│ Y  │  │   ▾ notes/       │ │ ◐ Stream „payments"  │ ││  │  ┌────┐      │ +composer │ │
│ ─  │  │     📄 plan.md ⬤ │ │  · nicht auf main —  │ ││  │  │card│      │           │ │ ← .main UNVERÄNDERT
│ ▤  │  │ ▾ src/           │ │  landet mit dessen PR│ ││  │  └────┘      │           │ │   (Grid + Inspector
│ ◆  │  │   ▾ mail/        │ ├──────────────────────┤ ││  │              │           │ │    bleiben sichtbar)
│ ⛁  │  │     📄 mail.py 🔴 │ │ # Plan               │ ││  └──────────────────────────┘ │
│ ⚙  │  │ ▸ src-tauri/     │ │ GitHub-Render ([[08]])│ ││                                │
│ «  │  │ ·(.git/ node_…)  │ │ …                    │ ││                                │
│    │  │   ausgeblend.(§6)│ └──────────────────────┘ ││                                │
│    │  └──────────────────┴──[ Vorschau | Bearbeiten ]┘│                                │
└────┴───────────────────────────────────────────────┴───────────────────────────────┘
   ↑ Activity-Rail   ↑ Explorer = Mittel-Spalte (Primary-Panel)   ↑ .main bleibt (Grid+Inspector)
     ([[10-navigation-toolbar]]) — „▤ Dateien" aktiviert activeView==="files"
```

- **Stream-Kontext-Selector (Panel-Header):** ein Popover/Dropdown, das `main / Integrator` (→
  `project.repoRoot`) und jeden aktiven Sub-Agent listet — je Eintrag der **`StatusDot`** (Farbe aus
  `STATUS_META[agent.status]`) + das `label`. Der gewählte Eintrag steht prominent im Header, sodass
  „wessen Dateien?" sofort lesbar ist. Wahl → `setActiveRoot(...)` (§3.2). Die rote Trespass-Warnung
  am Tree/Content (§5.3) zeigt nur, wenn eine **fremde** Region berührt wird — der Worktree-Kontext
  selbst ist neutral/informativ.
- **Tree-Knoten:** Disclosure-Triangle (`▾`/`▸`), Datei-Icon, Name; rechts ein optionaler
  Status-Marker (`⬤ agent` = vom gewählten Stream berührt/neu, `🔴 collision` = Kollision/Trespass,
  §5.3). `.git/`/`node_modules/`/`target/` werden gar nicht erst gelistet (§6).
- **Content-Header:** Dateiname + `●`-Dirty-Marker + Mode-Toggle `[Vorschau | Bearbeiten]`.
- **Material:** Baum = Sidebar-artig (`--sidebar-bg`); Content = opak (`--panel`), nie Vibrancy
  unter Code/Editor ([[macos-design]] A.5).

---

## 2. Komponenten-Architektur

Alle neuen Komponenten leben unter `src/components/` und folgen den bestehenden Idiomen
(`src/components/Inspector.tsx`, `MessageTimeline.tsx`): reine UI, lesen aus `useStore`, senden
Intents über Store-Actions. **Keine** direkten `invoke`-Aufrufe in den Komponenten — FS-Aufrufe
gehen über neue Store-Actions (§3), analog dazu, wie `Inspector` heute `sendInput`/`createPr`
nur über den Store anstößt.

### 2.1 Komponentenbaum & Mount

```
App.tsx  (.app = Rail | Primary-Panel | Main; bei activeView==="files" rendert PrimaryPanel <FileExplorer/>)
└── <FileExplorer/>              → .file-explorer (Mittel-Spalte; flex column)
    ├── <StreamContextSwitcher/> → header.file-context (Stream-Kontext-Selector, §1.2/§1.3 — PRIMÄR)
    └── (flex row)
        ├── <FileTree root=…/>    → aside.file-tree   (virtualisiert, lazy)
        └── <FileContent path=…/> → section.file-content
            ├── <FileWarnings path=…/>   (In-Worktree-Info- / Trespass- / External-Change-Banner)
            ├── <FilePreview path=… kind=…/>   (preview-Mode)
            └── <FileEditor path=… kind=…/>    (edit-Mode)
```

Mount-Regel (LAYOUT-CONTRACT (f), konsistent mit [[10-navigation-toolbar]] §2.2): `App.tsx` rendert
**drei** Geschwister — `<ActivityRail/>`, `<PrimaryPanel/>`, `<div className="main">` — und
`PrimaryPanel` ist der `activeView`-Switch ([[10-navigation-toolbar]]): bei `"files"` rendert es
`<FileExplorer/>` als **eigene Mittel-Spalte**, bei `"streams"` rendert es `null` (kein Mittel-Panel).
Der Explorer **ersetzt nichts** in `.main`: `.center` (`AgentGrid`) und `<Inspector/>` bleiben
unverändert rechts stehen und sichtbar; der Explorer belegt **nur** die Spalte, die im Streams-View
**leer** ist. Es gibt **keine** persistente Sidebar mehr, gegen die der Explorer ankleben oder die er
verdrängen müsste — die alte 232px-Stream-`Sidebar` ist aufgelöst ([[10-navigation-toolbar]] §1a).
Keine strukturelle Umwälzung in `.main`, nur eine zusätzliche, bedarfsweise Mittel-Spalte über
denselben Store.

### 2.2 Props & Verantwortlichkeiten

| Komponente | Props | Verantwortung | Darf NICHT |
|---|---|---|---|
| **`FileExplorer`** | `—` (liest `activeRoot`, `selectedFilePath` aus Store) | Orchestriert Header + Baum + Content | I/O ausführen; Pfade selbst auflösen |
| **`StreamContextSwitcher`** | `—` (liest `order`/`agents`/`activeRoot`/`selectedId`) | **Primärer Stream-Kontext-Selector** (§1.2/§1.3): listet `main / Integrator` (`project.repoRoot`) + jeden aktiven Sub-Agent (`StatusDot` aus `STATUS_META[agent.status]` + `label`); Wahl → `setActiveRoot(...)`. Default = `selectedId`, sonst `main`. | Worktree-Pfade selbst bilden (kommen aus `agents[id].worktreePath`); I/O |
| **`FileTree`** | `{ root: string }` | Baut auf **`react-arborist@3.10.5`** (virtualisiert, Keyboard-Nav, lazy Children per Knoten); ruft `expandDir(path)` beim Aufklappen; Filter/Suche; Status-Marker | rekursiv walken (Core walkt); `.gitignore` interpretieren (Core, §6) |
| **`FileContent`** | `{ path: string }` | Mode-Switch (preview/edit); Header mit Dirty-Marker | I/O; Diff-Berechnung |
| **`FileWarnings`** | `{ path: string }` | In-Worktree-**Info**-Leiste (gewählter Worktree = Normalfall) / **Trespass**-Warnung (fremde Region) / External-Change-Banner aus Store-Joins (§5.3) | `detectTrespass` neu erfinden (nutzt `shared/ownership.ts`); den eigenen Worktree-Kontext als Fehler darstellen |
| **`FilePreview`** | `{ path; kind }` | Markdown → Renderer aus [[08-markdown-editor]]; Code → CodeMirror read-only-Highlight; Bild → `<img>` aus Data-URL (aus `bytesBase64`, unter Image-Cap §6); Binär (oder Bild über Cap) → Fallback-Karte | schreiben |
| **`FileEditor`** | `{ path; kind }` | CodeMirror 6 (Code) / MD-Editor [[08-markdown-editor]] (Markdown); Buffer-Verwaltung; `Cmd+S` → `saveFile` | direkt auf Platte schreiben (über Store-Action) |

`FilePreview`/`FileEditor` teilen die Typ-Erkennung
(`fileKind(path, coreKind: "text" | "binary"): "markdown" | "code" | "image" | "binary"`). Sie
schlüsselt auf die **Datei-Endung** (`.md`/`.markdown` → `markdown`; bekannte Code-Endungen →
`code`; `.png`/`.jpg`/`.gif`/`.webp`/`.svg` → `image`) **plus das Core-Flag** `coreKind` aus dem
`FileRead`-Resultat (§4.2): liefert der Core `kind:"binary"`, kann es nie `markdown`/`code`
werden — ein Nicht-Bild-Binär landet als `binary`-Fallback. Der Webview bekommt **keinen** rohen
Byte-Head zu sehen (der Core liefert bereits dekodierten Text oder base64) — daher kein `bytesHead`.
Markdown reuse den `Md`-Renderer-Ansatz aus
`src/components/MessageTimeline.tsx` (heute `react-markdown` + `remark-gfm`), in
[[08-markdown-editor]] zur vollen GitHub-Style-Pipeline (`rehype-starry-night`, `rehype-sanitize`,
`github-markdown-css`) ausgebaut. Code/Editor verwenden **CodeMirror 6** (eine Engine für 07/08/09,
siehe REACT-UI-Entscheidung; **kein** Monaco).

---

## 3. State & Datenfluss

### 3.1 Store-Erweiterungen (`src/store.ts`)

Der Store (`useStore = create<MadsState>(...)`) bekommt einen FS-Slice. Konsistent mit der
bestehenden Form (`agents: Record<string, AgentVM>`, `events: Record<…>`, `drafts: Record<…>`):

```typescript
// src/store.ts — neue Felder auf MadsState

/**
 * Welcher Stream-Kontext wird gebrowst — main/Integrator ODER ein Sub-Agent-Worktree.
 * BEIDE Varianten sind gleichwertig: beide werden per `setActiveRoot` im Core registriert
 * (`allow_directory`, §3.2/§4.2) und sind damit lesbar UND schreibbar (OE-35 entschieden, §11).
 * `agentId` koppelt die Worktree-Variante an einen `AgentVM` (label/status/worktreePath) für den
 * Stream-Kontext-Selector (§1.3) und die Info-Leiste (§5.3).
 */
type ExplorerRoot =
  | { kind: "project"; path: string }                 // project.repoRoot — main / Integrator
  | { kind: "worktree"; agentId: string; path: string }; // agents[agentId].worktreePath
                                                         //   = ~/mads-worktrees/<slug>/<agentId>

interface DirNode {
  name: string;
  path: string;            // absoluter Pfad (vom Core geliefert, kanonisiert)
  isDir: boolean;
  isSymlink: boolean;
}

interface OpenFile {
  path: string;
  kind: "markdown" | "code" | "image" | "binary";
  diskMtimeMs: number;     // beim Laden gemerkt — Teil des Conflict-Signals (§7)
  diskSize: number;        // Bytes auf Disk — Teil des Conflict-Signals (§7)
  diskHash: string;        // content-hash beim Laden — autoritatives Conflict-Signal (§7)
  coreKind: "text" | "binary"; // was der Core beim Lesen entschieden hat (UTF-8 ok ⇒ text, sonst binary)
  loadedText?: string;     // bei coreKind:"text": Original-Inhalt (Dirty-Diff)
  bytesBase64?: string;    // bei coreKind:"binary": rohe Bytes (für Bild-Data-URL oder Binär-Fallback)
  dataUrl?: string;        // bei kind:"image": aus bytesBase64 + Media-Type abgeleitet
}

interface MadsState {
  // … bestehende Felder (sidecar, project, agents, order, events, drafts …) …

  activeRoot: ExplorerRoot | null;                 // gewählter Stream-Kontext (§1.2); null = kein Projekt offen.
                                                   //   Default beim Öffnen = der selektierte Stream
                                                   //   (selectedId → seine worktree), sonst { kind:"project" }.
  treeChildren: Record<string, DirNode[]>;         // keyed by Verzeichnis-Pfad (lazy gefüllt)
  treeExpanded: Record<string, boolean>;           // aufgeklappte Knoten
  treeFilter: string;                              // Filter-/Suchtext
  selectedFilePath?: string;
  openFile?: OpenFile;                             // aktuell im Content-Bereich
  editorBuffers: Record<string, string>;           // path → ungespeicherter Inhalt (dirty wenn ≠ loadedText)
  externalChanged: Record<string, boolean>;        // path → „auf Disk geändert" (fs-watch)
  fsError?: string;                                // letzter I/O-/Scope-Fehler (Inline-Anzeige)
}
```

### 3.2 Action-Signaturen (TS-Sketches)

Neue Actions, im Stil der bestehenden (`openProject`, `sendInput`, `selectAgent`). Sie kapseln die
`invoke`-Aufrufe an den Core (§4) — die Komponenten rufen **nur** diese:

```typescript
setActiveRoot(root: ExplorerRoot): Promise<void>;     // Stream-Kontext wechseln (§1.2). Registriert den Root im
                                                      //   Core via mads_register_root → app.fs_scope().allow_directory
                                                      //   — für eine "worktree"-Variante EXAKT wie für repoRoot, d.h.
                                                      //   der Worktree wird voll lesbar UND schreibbar (OE-35). Setzt
                                                      //   activeRoot + lädt Top-Level + setzt openFile/Tree-State zurück.
expandDir(path: string): Promise<void>;               // invoke("mads_read_dir") → treeChildren[path]
collapseDir(path: string): void;                      // nur UI
setTreeFilter(text: string): void;                    // nur UI (Client-Filter über geladene Knoten)
openFilePath(path: string): Promise<void>;            // Typ erkennen + read → openFile (preview)
enterEditMode(path: string): void;                    // editorBuffers[path] = loadedText
setEditorBuffer(path: string, text: string): void;    // dirty-Tracking
saveFile(path: string): Promise<void>;                // (mtime,size,hash)-Check → invoke("mads_write_file") → saved | conflicted
reloadFile(path: string): Promise<void>;              // verwirft Buffer (nach Bestätigung) + re-read
discardEdit(path: string): void;                      // editorBuffers[path] löschen
```

### 3.3 Datenfluss

```
Webview (FileTree)        Rust-Core (files.rs)            Disk (repoRoot / worktree)
─────────────────         ────────────────────            ──────────────────────────
expandDir(path) ──invoke("mads_read_dir",{path})──► canonicalize + Scope-Check
                                                   + ignore-Walk (1 Ebene, §6) ──► std::fs::read_dir
   treeChildren[path] ◄──── Vec<DirNode> ──────────┘
openFilePath(path) ──invoke("mads_read_file")────► Scope-Check + read + UTF-8-Versuch ─► std::fs::read
   openFile ◄──── FileRead{kind:text|binary, mtimeMs, size} ─┘ (Core entscheidet text/binary)
saveFile(path) ──invoke("mads_write_file",{mtime,size,hash})► Scope + (mtime,size,hash)-Re-Check ─► std::fs::write
   saved | conflicted ◄──── WriteResult ──────────────────────┘

External change:  notify-debouncer-full (Core) ──emit("fs:external_change",{path})──► externalChanged[path]=true
```

Wichtig: dieser Pfad ist **nicht** der NDJSON-Sidecar-Kanal. Datei-Bytes/Listings reisen über
**Tauri-Commands** (Request/Response) bzw. ein **Tauri-Event** für den Watch-Hinweis — nicht als
`SidecarMessage`. Begründung in §4/§5. Die Agent-Edit-Daten (welche Datei ein Agent gerade
anfasst) kommen weiterhin aus dem bestehenden `agent_event`/`tool_use`-Strom (für die
Status-Marker am Baum, §5.3) — das ist eine reine Store-Ableitung, **kein** neuer Protokoll-Typ.

---

## 4. Protokoll- & Core-Anbindung

### 4.1 Warum FS NICHT über `shared/protocol.ts`/Sidecar läuft

> **ENTSCHIEDEN (FS-Transport, OE-31):** Datei-I/O läuft **durch den Rust-Core** (CLAUDE.md:
> „Owner aller Child-Prozesse, IPC, Secrets, Persistenz") — über `tauri-plugin-fs` + mads-eigene
> `#[tauri::command]`s, **nicht** über den Sidecar. Der Sidecar-`stdout` ist **NDJSON-only**;
> Datei-Bytes/Listings dort durchzuschleifen würde den Protokoll-Kanal verschmutzen und einen
> Parse/Encode-Hop hinzufügen. Tauris Capability/ACL-Modell gilt zudem **nur** für die
> Webview↔Core-Brücke — der Sidecar liegt außerhalb. FS im Core = ein auditierbarer Chokepoint.

Daher: **keine** neuen `HostMessage`/`SidecarMessage`-Typen für Lesen/Schreiben. `shared/protocol.ts`
bleibt für den FS-Kern **unverändert**. Die einzige optionale, event-getragene Ergänzung ist der
Watch-Hinweis (`fs:external_change`) — und der ist ein **Tauri-Event** des Core, kein
Sidecar-Protokoll-Typ.

### 4.2 Was der Rust-Core dünn exponiert (`src-tauri/src/files.rs`)

Heute registriert `src-tauri/src/lib.rs` nur `start_sidecar`/`sidecar_send`/`stop_sidecar` und die
Plugins `tauri_plugin_opener`/`tauri_plugin_dialog`. Neu: ein FS-Modul, registriert im
`generate_handler!`, plus der fs-Plugin für `watch`:

```rust
// src-tauri/src/files.rs — bewusst dünn: Scope-Policy + std::fs, KEINE git/LLM-Logik.
#[derive(serde::Serialize)]
struct DirNode { name: String, path: String, is_dir: bool, is_symlink: bool }

// Diskriminiertes Lese-Resultat: DER CORE entscheidet text-vs-binary (nicht der Webview).
// UTF-8-Decode-Versuch gelingt ⇒ Text; schlägt fehl ⇒ Binär (base64). Der Webview bekommt
// nie einen rohen Byte-Head zu interpretieren — er liest nur `kind` + die fertige Payload.
#[derive(serde::Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum FileRead {
    Text   { text: String,        mtime_ms: f64, size: u64, truncated: bool },
    Binary { bytes_base64: String, mtime_ms: f64, size: u64, truncated: bool },
}

#[tauri::command]
fn mads_read_dir(state: State<FsScope>, path: String) -> Result<Vec<DirNode>, String> {
    let dir = ensure_in_scope(&state, &path)?;        // canonicalize + Prefix-Check (§5)
    read_dir_filtered(&dir)                            // 1 Ebene, ignore-Walk (.git/node_modules/target/.gitignore)
}

#[tauri::command]
fn mads_read_file(state: State<FsScope>, path: String) -> Result<FileRead, String> {
    let p = ensure_in_scope(&state, &path)?;
    read_capped(&p)                                    // liest Bytes (Cap §6) → UTF-8-Versuch:
                                                       //   Ok  ⇒ FileRead::Text   (auch das Conflict-Signal: mtime_ms + size)
                                                       //   Err ⇒ FileRead::Binary (base64) — Nicht-UTF-8-Regel sitzt HIER, im Core (§7)
}

#[tauri::command]
fn mads_write_file(
    state: State<FsScope>, path: String, content: String,
    base_mtime_ms: f64, base_size: u64, base_hash: String,   // Disk-Signatur beim Laden
) -> Result<WriteResult, String> {
    let p = ensure_in_scope(&state, &path)?;
    // Kein silent clobber (§7): NICHT bloß `mtime > base` (verpasst mtime-erhaltende oder grob-
    // aufgelöste Ersetzungen und feuert false-positive bei No-Op-`touch`). Stattdessen: Datei gilt
    // als „auf Disk geändert", wenn (mtime, size) abweicht ODER der content-hash abweicht.
    let cur = stat(&p)?;
    let changed = cur.mtime_ms != base_mtime_ms
        || cur.size != base_size
        || content_hash(&p)? != base_hash;            // Hash ist das autoritative Signal
    if changed { return Ok(WriteResult::Conflict); }
    std::fs::write(&p, content).map_err(|e| e.to_string())?;
    let after = stat(&p)?;
    Ok(WriteResult::Saved { mtime_ms: after.mtime_ms, size: after.size, hash: content_hash(&p)? })
}

// Laufzeit-Scope erweitern, sobald der Mensch ein Projekt/Worktree wählt:
#[tauri::command]
fn mads_register_root(app: AppHandle, state: State<FsScope>, path: String) -> Result<(), String> {
    let root = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
    app.fs_scope().allow_directory(&root, true);       // FsExt — repoRoot ist zur Build-Zeit unbekannt
    state.add_root(root);                              // mads-eigene Allow-Liste (der eigentliche Gate)
    Ok(())
}
```

```rust
// src-tauri/src/lib.rs — Registrierung (Ergänzung)
tauri::Builder::default()
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())                  // NEU — für watch + Plugin-Scope
    .manage(SidecarState::default())
    .manage(FsScope::default())                       // NEU — Laufzeit-Allow-Liste
    .invoke_handler(tauri::generate_handler![
        start_sidecar, sidecar_send, stop_sidecar,
        mads_read_dir, mads_read_file, mads_write_file, mads_register_root  // NEU
    ])
```

> **ENTSCHIEDEN (Read/Write = Custom-Command, Watch = Plugin, OE-32):** Lesen/Schreiben/Verzeichnis-
> Walk laufen über **mads-eigene Commands** (`std::fs` + `ignore`-Crate), damit die mads-Policy
> (Confinement auf `repoRoot` + Worktree-Prefix, `..`/Symlink-Reject) **im Core** sitzt — wie
> `sidecar.rs` Prozesse besitzt. Der **fs-Plugin-`watch`/`watchImmediate`** wird nur für den
> Live-Reload genutzt (debounced recursive watcher neu in Rust zu bauen lohnt nicht). Damit bleibt
> der Webview vollständig von der Platte getrennt.

> **Wichtig (Conflict-Signal & TOCTOU):** Der `mads_write_file`-Check vergleicht **(mtime, size)
> _und_ einen content-hash** (nicht bloß `mtime > base`), weil mtime allein mtime-erhaltende oder
> grob-aufgelöste Ersetzungen verpasst und bei No-Op-`touch` false-positive feuert; der Hash ist
> das autoritative Signal. Trotzdem bleibt zwischen Check und `std::fs::write` ein **TOCTOU-Fenster**
> — ein theoretisches Last-Writer-Wins-Restrisiko, das ein Re-Check vor dem Write nur verkleinert,
> nicht eliminiert. Deshalb ist **`watchImmediate` der primäre „auf Disk geändert"-Detektor**: er
> meldet die externe Änderung **proaktiv** (`fs:external_change`, §3.3) und löst den
> `external-changed`-Banner aus, bevor der Mensch überhaupt speichert — der mtime/size/hash-Check im
> Write ist die **zweite, reaktive Verteidigungslinie** für den Fall, dass die Änderung zwischen
> Watch-Event und Save passiert.

### 4.3 Erforderliche `tauri-plugin-fs`-Capabilities

Eine eigene Capability-Datei `src-tauri/capabilities/fs.json` (neben dem bestehenden
`default.json`, das heute nur `core:default`/`opener:default`/`dialog:default` hält). Scope mit
**Deny-Vorrang** für Secrets/VCS; `requireLiteralLeadingDot: true`, damit `**`-Globs keine
Dotfolder einsammeln:

```jsonc
// src-tauri/capabilities/fs.json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "mads-fs",
  "description": "Projekt-Explorer + Editor — nur watch über das Plugin; Read/Write via Custom-Command",
  "windows": ["main"],
  "permissions": [
    "fs:allow-watch",                       // braucht das cargo-feature "watch"
    {
      "identifier": "fs:scope",
      "allow": [
        { "path": "$HOME/mads-worktrees/**" }
      ],
      "deny": [
        { "path": "$HOME/**/.git/**" },
        { "path": "$HOME/**/.env" },
        { "path": "$HOME/**/.env.*" },
        { "path": "$HOME/**/.ssh/**" },
        { "path": "$HOME/**/.aws/**" },
        { "path": "$HOME/**/node_modules/**" },
        { "path": "$HOME/**/target/**" }
      ]
    }
  ]
}
```

```jsonc
// src-tauri/tauri.conf.json — Ergänzung
{ "plugins": { "fs": { "requireLiteralLeadingDot": true } } }
```

Das beliebige, vom Menschen gewählte `repoRoot` wird **nicht** statisch in die Capability
geschrieben (zur Build-Zeit unbekannt) — es kommt zur Laufzeit über
`app.fs_scope().allow_directory(repoRoot, true)` (`mads_register_root`, §4.2), aufgerufen direkt
nachdem `project` gesetzt ist. **Ein gewählter Sub-Agent-Worktree wird zur Laufzeit auf
identischem Weg registriert:** `setActiveRoot({kind:"worktree", path})` ruft denselben
`mads_register_root` → `allow_directory(worktreePath, true)`. Damit ist ein Worktree-Root **exakt so
lesbar UND schreibbar** wie `repoRoot` — kein read-only-Sonderfall (OE-35 entschieden, §11). Die
statische Capability deckt zwar bereits den fixen Worktrees-Ort `~/mads-worktrees/**` als groben
äußeren Glob; autoritativ ist aber — wie bei `repoRoot` — der **kanonische Prefix-Check im Core**
(§5.1) gegen den jeweils registrierten Worktree-Pfad. Das `recursive: true`-Flag von
`allow_directory` umfasst Lesen **und** Schreiben — der zweite, autoritative Gate
(`ensure_in_scope`) entscheidet pro Pfad.

> **Lockfile-Hinweis:** `tauri-plugin-fs` (Cargo) + `@tauri-apps/plugin-fs` (npm) + `ignore`/
> `notify-debouncer-full` (Cargo) + **`react-arborist@3.10.5`** (npm, FileTree-Komponente, §2.2)
> bumpen **`Cargo.lock` und `package-lock.json`** → das ist ein geteilter Datei-Edit, der dem
> paix-Shared-File-Protokoll unterliegt (land-first oder single-owner, CLAUDE.md „Build & Gates").
> Beide Lockfile-Achsen frozen-grün halten.

---

## 5. Sicherheit & Schicht-Grenzen

> **Wichtige Grenze (CLAUDE.md §Schichten):** „`src/` — React/TS-Frontend. Reines UI … **Keine**
> Prozesse, **keine** Secrets, **keine** git/gh-Ausführung." mads erweitert das hier um: **kein**
> direkter Disk-Zugriff aus dem Webview. Der Webview ruft nur Store-Actions; die Actions rufen
> Core-Commands; der Core ist der einzige Ort mit `std::fs`.

### 5.1 Capability-Scoping & Laufzeit-Gate (zwei Schichten)

1. **Capability-Glob** (`fs.json`, §4.3) ist nur der **grobe äußere Gate**: er deckt den fixen
   Worktrees-Ort literal; **Deny** schlägt **Allow** (runtime-erzwungen) → `.git`/`.env*`/`.ssh`/
   `.aws`/`node_modules`/`target` sind hart gesperrt. Der Glob ist **literal** (kein canonicalize) —
   auf macOS kann ein symlinkter Root (z.B. `/tmp` → `/private/tmp`) den literalen Glob verfehlen,
   obwohl der kanonische Prefix-Check ihn akzeptiert; deshalb ist der Glob **nicht** autoritativ.
2. **Laufzeit-Prefix-Check im Core** (`ensure_in_scope`) ist der **autoritative** Gate: jeder
   angefragte Pfad wird `canonicalize()`d und muss Prefix-Descendant des — ebenfalls `canonicalize()`d
   registrierten — `repoRoot` **oder** eines `~/mads-worktrees/<repo-slug>/<agentId>` sein, sonst
   Reject. Weil beide Seiten kanonisiert werden, entscheidet **dieser** Check (nicht der literale
   Glob) über jeden Symlink-Fall — er schlägt Symlink-Escape und `..`-Traversal, die der Glob allein
   weder abdeckt (Escape) noch korrekt durchlässt (legitimer `/tmp`→`/private/tmp`-Root).

### 5.2 Path-Traversal, Secrets, Link-Safety

- **`..`-Traversal:** sowohl `tauri-plugin-fs` (lehnt Parent-Accessoren ab) als auch der
  Core-Check (`canonicalize` + Prefix) blocken es. Pfade aus dem Webview werden **nie** unverifiziert
  an `std::fs` durchgereicht.
- **Secrets:** `.env`/`.env.*`/`.ssh`/`.aws` sind per Deny gesperrt; sie tauchen weder im Baum auf
  noch sind sie lesbar. Geheimnisse bleiben Sache des Core ([[01-architecture]]) — der Explorer
  ist **kein** Secret-Pfad. (Hinweis: `.env` ist gesperrt, auch wenn es im Projekt liegt — bewusst,
  lieber zu streng.)
- **Untrusted/agent-authored content:** Eine Datei kann von einem Agenten geschrieben worden sein.
  Vorschau-Rendering ist daher **sanitisiert**: Markdown läuft durch `rehype-sanitize` (letzter
  Schritt der Pipeline aus [[08-markdown-editor]]); HTML wird **nie** ungefiltert ausgeführt.
- **Link-Safety:** Links in gerenderter Vorschau öffnen — wie heute in
  `src/components/MessageTimeline.tsx` (`a`-Override → `openUrl` aus `@tauri-apps/plugin-opener`) —
  **extern im Browser**, nicht in-app. Kein `target`-Navigations-Hijack im Webview.
- **Bilder:** als Data-URL aus dem vom Core gelesenen Byte-Buffer (`bytesBase64`), **mit Größen-Cap**
  (§6, Image-Cap): über der Schwelle Binär-Fallback statt Data-URL — so kann eine agent-geschriebene
  Riesen-Bilddatei den Webview nicht sprengen. Kein `file://`/Remote-Fetch im Webview. Heute steht
  `csp: null` (`src-tauri/tauri.conf.json`); mit dem Explorer sollte die CSP **enger** gesetzt werden
  — mindestens `img-src 'self' data:` (Data-URL-Bilder erlaubt, alles andere gesperrt), damit der
  konservative Data-URL-Pfad auch durch die Policy erzwungen ist.

### 5.3 Kontext-Info vs. Koordinations-Warnung (Edit im eigenen Worktree vs. auf fremder Region)

Das ist der direkte Bezug zu [[06-ownership-and-coordination]]. Der Join-Key ist der **Pfad**
(plus optional Symbol). `FileWarnings` baut die Leisten aus reinen Store-Ableitungen — **ohne** neuen
Protokoll-Typ, weil die Daten schon fließen. Entscheidend ist die **Trennung** zwischen dem
**erwarteten** Worktree-Kontext (informativ) und einem **echten** Region-Trespass (Warnung):

- **In-Worktree-Kontext (INFORMATIV, kein Blocker):** ist `activeRoot.kind === "worktree"`, zeigt
  `FileWarnings` eine **neutrale/blaue Info-Leiste** „Du editierst in Stream X' Worktree · diese
  Änderung ist **noch nicht auf `main`** und landet erst, wenn dessen PR vom Integrator gemergt wird
  ([[03-main-agent]])." Das ist der **Normalfall** beim Review einer noch-nicht-gemergten Datei
  (§0-Use-Case) — **keine** Warnung, **kein** „lieber im main editieren". Editieren im gewählten
  Worktree ist die unterstützte Standard-Aktion (OE-35 entschieden, §11).
- **Fremde Region (Ownership-Trespass → WARNUNG):** sind Ownership-Regeln geladen, läuft
  `detectTrespass` (`shared/ownership.ts`, pur, bereits von beiden Schichten importierbar) gegen die
  offene Datei. Trifft sie eine Region, die ein **anderer** Stream besitzt
  (`owned_symbol`/`owned_pattern`/`exclusive_file`) → **rote** Leiste „Region gehört Stream Y"
  ([[06-ownership-and-coordination]]). Das ist genuiner Trespass und bleibt eine echte Warnung —
  **unabhängig** davon, in welchem Worktree man gerade ist.
- **Live-Kollision:** erscheint der Pfad in `collisions: Collision[]` (Store, aus `collision_warning`)
  → `severity:"region"` = rot (+ Symbol + Rival-Stream), `severity:"file"` = amber
  („möglicher Überlapp"). Exakt die paix-Nuance: dieselbe Datei + disjunkte Symbole = **keine**
  Kollision ([[06-ownership-and-coordination]] §0).
- **Nebenläufiger Agent-Write (CAVEAT):** schreibt der gewählte Stream die offene Datei
  **gleichzeitig** (er ist nicht idle), ist ein Edit-Konflikt real. mads weist im Editor darauf hin
  („Stream X schreibt aktiv — Pausieren empfohlen") und empfiehlt, **den Stream zu pausieren**
  (`interrupt_agent`, [[02-dashboard]] §9.1) **oder im Leerlauf zu editieren**. Mechanisch greifen
  zwei vorhandene Schichten: (a) `watchImmediate` meldet die externe Änderung **proaktiv**
  (`external-changed`-Banner, §4.2) und (b) der mtime/size/hash-Re-Check in `mads_write_file`
  verhindert beim Save den silent clobber (→ `conflicted`-Sheet, §4.2/§7).

Alle Leisten sind **beratend, nicht blockierend** — der Mensch bleibt souverän. Die Info-Leiste macht
nur **transparent**, dass eine Worktree-Änderung den `main`-Branch erst über den regulären PR/Merge
erreicht; die Trespass-/Kollisions-Warnung macht das Risiko sichtbar, bevor daraus ein harter
Merge-Konflikt wird.

---

## 6. Performance & Skalierung

| Mechanismus | Umsetzung |
|---|---|
| **Lazy Loading** | `mads_read_dir` liefert **genau eine Ebene**; Kinder werden erst beim Aufklappen geladen (`expandDir`). Nie ein rekursiver Whole-Tree-Walk aus JS. |
| **Virtualisierung** | **`react-arborist@3.10.5`** rendert nur sichtbare Zeilen (eingebaute Virtualisierung via `rowHeight`/`height`) und bringt Keyboard-Nav/lazy Children mit — derselbe Cap-zeigen-statt-still-laden-Geist wie der virtualisierte Grid-Ansatz aus [[02-dashboard]] §8 (Design-Ziel, nicht heute schon im Code). Tiefe/breite Bäume bleiben flüssig. |
| **Ignore-Walk im Core** | `.git/`/`node_modules/`/`target/`/`dist`/`.next` werden **server-seitig** übersprungen; `.gitignore` wird über die `ignore`-Crate (ripgrep-Walker) ausgewertet — eine vertrauenswürdige Stelle, ein Resultat über die IPC-Grenze statt tausender `DirEntry`. |
| **Read-Caps (Text)** | `mads_read_file` cappt sehr große Text-Dateien (z.B. > 2 MB) → `truncated: true`. Die Vorschau zeigt dann einen **expliziten Hinweis** „Datei gekürzt (N MB) — [Trotzdem ganz laden]"; **nie** stilles Abschneiden. |
| **Image-Cap** | Bilder sind als Data-URL (§5.2) potenziell beliebig groß — eine agent-geschriebene PNG könnte den Webview-Speicher sprengen. Daher cappt der Core auch Bilder (Vorschlag: > 5 MB, OE-34): über der Schwelle **kein** Data-URL, sondern dieselbe **Binär-Fallback-Karte** wie für sonstige Binärdateien (Typ, Größe, „im Finder zeigen" Post-MVP) — Cap **anzeigen**, konsistent mit dem Text-Cap. |
| **Directory-Caps** | Verzeichnisse mit sehr vielen Einträgen (z.B. > 2000) werden gekappt → sichtbarer „… N weitere ausgeblendet"-Knoten + stderr-`log()` im Core. Cap **anzeigen**, nicht verschweigen. |
| **Watch-Coalescing** | Tree-Watch via `notify-debouncer-full` @ ~300 ms (Rename-Stitching, Dedup, Ignore-Filter server-seitig) → ein koalesziertes `fs:external_change`-Event statt eines Floods. Die **offene Datei** nutzt `watchImmediate` (kein Debounce) für prompte Reload-Hinweise. |
| **Filter** | `treeFilter` filtert client-seitig über bereits geladene Knoten (kein Re-Walk pro Tastendruck). Tiefe Suche („alle Dateien") ist Post-MVP (§10). |

> **Querverweis [[02-dashboard]] §8:** mads cappt Memory bereits an mehreren Stellen (Event-Ring-
> Buffer 800, Scrollback). Der Explorer reiht sich ein: jeder Cap wird **geloggt/angezeigt**, nie
> still durchgeführt.

---

## 7. Edge-Cases & Fehlerzustände

| Fall | Verhalten |
|---|---|
| **Kein Projekt offen** | `activeRoot === null` → Explorer-Empty-State „Projekt öffnen" (wie [[02-dashboard]] §10 „kein Repo"). |
| **Disk-Drift beim Save** | `mads_write_file` vergleicht **(mtime, size) + content-hash** gegen den Lade-Zustand (§4.2) → bei Abweichung `Conflict` → `conflicted`-Sheet: `[Disk laden]` / `[Meine Version überschreiben]`. **Kein** silent clobber; TOCTOU-Restfenster ist via `watchImmediate` proaktiv abgedeckt. |
| **External change, Datei nicht dirty** | Banner „auf Disk geändert · [Neu laden]"; Reload ohne Rückfrage. |
| **External change, Datei dirty** | Banner + Reload-Bestätigung („lokale Änderungen verwerfen?"). |
| **Datei gelöscht extern** | `external_change` → Re-Read schlägt fehl → Banner „Datei wurde gelöscht"; Buffer bleibt erhalten, Save bietet „neu anlegen" an (im Scope). |
| **Scope-/Permission-Reject** | Inline-Fehlerzeile aus `fsError`; Datei read-only; kein Modal. |
| **Binär/sehr groß** | Binär → Fallback-Karte (Typ, Größe, „im Finder zeigen" Post-MVP); groß → Truncation-Hinweis (§6). |
| **Symlink** | Im Baum als `isSymlink` markiert; Folgen nur, wenn das Ziel **in-scope** ist (Core-Check), sonst Reject — verhindert Symlink-Escape. |
| **Agent schreibt offene Datei nebenläufig** | Der gewählte Stream ist nicht idle und editiert dieselbe Datei → `watchImmediate` → `external-changed`-Banner (proaktiv); Save erkennt Drift via mtime/size/hash → `conflicted`-Sheet. Empfehlung: **Stream pausieren** (`interrupt_agent`) **oder im Leerlauf editieren** (§5.3-Caveat). |
| **Worktree verschwindet** | Sub-Agent gestoppt mit `removeWorktree` → `activeRoot` (`kind:"worktree"`) ungültig → Stream-Kontext-Selector fällt automatisch auf `main`/`project`-Root zurück + Hinweis „Worktree von Stream X entfernt". Offene un-gespeicherte Buffer aus diesem Worktree bleiben im Speicher, Save schlägt mit Scope-Reject fehl (Datei existiert nicht mehr). |
| **Encoding** | **Der Core entscheidet** (`mads_read_file`, §4.2): UTF-8-Decode-Versuch gelingt ⇒ `FileRead::Text`, schlägt fehl ⇒ `FileRead::Binary` (base64). Nicht-UTF-8 wird also schon im Core als Binär klassifiziert (`coreKind:"binary"`) und landet im Fallback — der Webview rendert nie fehlerhaft, weil er nie rohe Bytes selbst dekodiert. |

---

## 8. Barrierefreiheit & Tastatur

Konsistent mit [[02-dashboard]] §11 (HIG/`macos-design.md` Teil D):

- **Tree-A11y:** `role="tree"`/`role="treeitem"`, `aria-expanded`/`aria-level`/`aria-selected`;
  Pfeiltasten navigieren (`↑/↓` Knoten, `→` aufklappen/erstes Kind, `←` zuklappen/Parent),
  `Enter`/`Space` öffnet die Datei.
- **Fokus:** logische Tab-Reihenfolge Rail → Stream-Kontext-Selector → Tree → Content-Header (Mode-Toggle) → Editor;
  sichtbare `:focus-visible`-Ringe.
- **Shortcuts** (überschreiben keine System-Shortcuts, erscheinen in der Menüleiste):

| Shortcut | Bedeutung |
|---|---|
| **⌘S** | Datei speichern (im edit-Mode) |
| **⌘F** | Baum-Filter / In-Datei-Suche fokussieren |
| **⌘⇧E** | Explorer-Panel ein/aus (Rail „Dateien"; finale Belegung in [[10-navigation-toolbar]]) |
| **Esc** | edit → preview (mit Dirty-Rückfrage) |
| **⌘0** | bleibt Inbox ([[02-dashboard]]) — kein Konflikt |

- **Farbe nie allein:** Status-Marker am Baum tragen Farbe **+ Icon + Label** (`⬤ agent`,
  `🔴 collision`), Dirty als `●` + Tooltip — wie die Ampel-Regel in [[02-dashboard]] §3.2.
- **Reduced Motion/Transparency:** Disclosure-Animationen respektieren `prefers-reduced-motion`;
  Sidebar-Material weicht bei `prefers-reduced-transparency` auf solide Flächen aus.
- **VoiceOver:** Banner (Owner-Warnung, external-change) als **Live-Region**, damit der Wechsel
  angesagt wird.

---

## 9. Tests

mads testet die reine Logik in `shared/` bereits per vitest (`shared/collision.test.ts`,
`shared/ownership.ts`). Der Explorer folgt dem Muster: **pure Funktionen unit-testen, I/O an der
Grenze isolieren.**

**Unit (vitest, Frontend/shared):**
- `fileKind(path, coreKind)` — Markdown/Code/Bild/Binär-Klassifikation aus Endung + Core-Flag;
  speziell: `coreKind:"binary"` überstimmt eine Code-/Markdown-Endung (Nicht-UTF-8 → Binär-Fallback).
- Dirty-Ableitung: `editorBuffers[path] !== loadedText`.
- Tree-Filter über geladene Knoten (Treffer/Highlight, leeres Resultat).
- **Owner-/Collision-Join** in `FileWarnings`: gegebene `Collision[]`/`OwnershipRule[]` + Pfad →
  korrekte Banner-Stufe (grün/amber/rot) — reuse `detectTrespass`/`detectCollisions` aus `shared/`,
  damit Explorer und Scan **dieselbe** Konflikt-Logik nutzen.
- Store-Reducer: `saveFile`-Conflict-Pfad (mtime-Drift) setzt `conflicted` statt zu überschreiben.

**Rust (cargo, Core):**
- `ensure_in_scope`: Prefix-Check, `..`-Reject, Symlink-Escape-Reject, Deny-Vorrang
  (`.env`/`.git`).
- `ensure_in_scope` (macOS-Symlink-Root): ein über `/tmp` (→ `/private/tmp`) registrierter Root —
  der den literalen Capability-Glob verfehlen würde — wird vom kanonischen Prefix-Check **akzeptiert**
  (legitimer Pfad), während ein Symlink, der **aus** dem kanonischen Root **heraus** zeigt,
  **rejected** wird. Beweist: der canonicalize-Prefix-Check, nicht der literale Glob, ist autoritativ
  (§5.1).
- `read_dir_filtered`: `.git`/`node_modules`/`target` ausgeblendet, `.gitignore` respektiert,
  Directory-Cap greift + loggt.
- `mads_write_file`: (mtime, size) + content-hash-Re-Check → `Conflict` ohne Schreiben; speziell
  der mtime-erhaltende-Ersetzung-Fall (gleiche mtime, anderer Inhalt) muss via Hash erkannt werden.

**Integration:**
- expand → read → edit → save → external-change → reload als ein Store-Flow (gemockter
  `invoke`/Event, wie der Sidecar-Channel heute mockbar ist).

---

## 10. Roadmap

Eingeordnet in die bestehende P-Roadmap ([[01-architecture]] §10) und konform zu **OE-3**
(MVP = ein Hauptfenster, kein Detach). Weil der Explorer als **Mittel-Spalte** (Primary-Panel-Slot)
mountet und in `.main` **nichts** ersetzt (§2.1, LAYOUT-CONTRACT (f)), bleibt `.main` mit `AgentGrid`
+ `Inspector` **durchgehend sichtbar** — die Live-Inspector-Timeline geht **nicht verloren**, und der
Streams-View ist über **⌘1** ([[02-dashboard]] §9.2) einen Tastendruck entfernt. Der Panel-Wechsel ist
ein **reiner `activeView`-Render-Switch über denselben Store** — keine Daten gehen verloren, kein
State wird zurückgesetzt; genau das macht das **Browsen UND Editieren von Sub-Agent-Worktrees**
(§0, der Kern-Use-Case) ohne zweites Fenster tragfähig.

| Phase | Inhalt |
|---|---|
| **MVP (P-FE-a)** | **Stream-Kontext-Selector** (main + aktive Sub-Agent-Worktrees, §1.2/§1.3); Baum (lazy, virtualisiert, ignore-aware) über den **gewählten** Root; Vorschau (Markdown via [[08-markdown-editor]], Code-Highlight, Bild, Binär-Fallback); Core-Commands `mads_read_dir`/`mads_read_file` + `mads_register_root` (für `repoRoot` **und** Worktree-Roots); fs-Capability + Laufzeit-Scope. **Read-only.** Einstieg über das Rail-Icon ([[10-navigation-toolbar]]). |
| **MVP (P-FE-b)** | Editor (CodeMirror 6 / MD-Editor aus [[08-markdown-editor]]) **im gewählten Stream-Kontext — main UND Sub-Agent-Worktree** (OE-35); `mads_write_file` mit mtime/hash-Conflict; Dirty/Saved/Conflicted; Filter. Damit ist der Kern-Use-Case (Sub-Agent schreibt `.md` → Mensch reviewt + editiert in dessen Worktree, §0/§1.2) **MVP-Funktion**. |
| **MVP (P-FE-c)** | Live-Reload (fs-watch, `external_change`); In-Worktree-Info-Leiste + Trespass-/Kollisions-Warnung (§5.3); nebenläufiger-Agent-Write-Caveat (pausieren/idle). |
| **Post-MVP** | Tiefe Volltext-Suche im gewählten Kontext; Datei-Operationen (anlegen/umbenennen/löschen, im Scope); „im Finder zeigen"; Diff-Inline gegen `loadedText` ([[09-change-overview]] teilt den Renderer); optional Datei-Tabs (mehrere offene Dateien); Detach-to-Window (OE-3). |

MVP bleibt **ein Fenster** — der Explorer ist eine bedarfsweise Mittel-Spalte über denselben Store,
kein eigenes Window (OE-3); `.main` (Grid + Inspector) und die Stream-Timeline bleiben durchgehend
sichtbar, der Streams-View ist per ⌘1 einen Tastendruck entfernt. Das **Sub-Agent-Worktree-Browsing
und -Editieren ist MVP** (P-FE-a/b), kein Post-MVP-Zusatz mehr.

---

## 11. Offene Entscheidungen

Neue OEs dieses Dokuments (Bereich „Datei-Explorer / Editor, Doc 07"); in README zu konsolidieren.

> **Konsolidierungs-Aufgaben (noch offen, beim Landen von Doc 07 zu erledigen):**
> 1. **README-Index:** neue Zeile für `[[07-file-explorer]]` in der Doc-Index-Tabelle.
> 2. **Doc-Zähler:** Überschrift „Die **sechs** Design-Dokumente" → „**sieben**" (bzw. den
>    tatsächlichen Stand inkl. 08–10, falls die parallel landen) aktualisieren.
> 3. **OE-Registry:** neue Gruppe `### Datei-Explorer / Editor (Doc 07)` mit **OE-31 … OE-35**
>    (FS-Transport ✅, Command-Aufteilung ✅, Edit-Confinement, Read-Cap-Größe, **Worktree-Schreibrechte
>    ✅ — OE-35 jetzt ENTSCHIEDEN: Editieren im gewählten Sub-Agent-Worktree IST erlaubt**)
>    in README `## Offene Entscheidungen (konsolidiert)`; höchste bisherige OE war OE-30.
> 4. **Glossar:** neue Begriffe in README `## Glossar zentraler Begriffe` ergänzen — `ExplorerRoot`,
>    `OpenFile`/`FileRead` (Core-text/binary-Diskriminierung), `FsScope`/`ensure_in_scope`
>    (Laufzeit-Prefix-Gate), `mads_read_dir`/`mads_read_file`/`mads_write_file`/`mads_register_root`.
> 5. **Cross-Ref in 01:** in `[[01-architecture]]` §0 (Querverweis-Tabelle) eine Zeile für
>    `[[07-file-explorer]]` (Schicht-Test: FS durch den Core, Capability-/IPC-Topologie).

> **ENTSCHIEDEN (FS-Transport, OE-31):** FS läuft durch den **Rust-Core** (Plugin + Custom-Command),
> **nicht** über den Sidecar/NDJSON. Begründung §4.1.

> **ENTSCHIEDEN (Command-Aufteilung, OE-32):** Read/Write/Dir-Walk = **mads-eigene Commands**
> (`std::fs` + `ignore`-Crate, Policy im Core); **Watch** = `tauri-plugin-fs` `watchImmediate`/
> debounced. Begründung §4.2.

> **OFFENE FRAGE (Edit-Confinement / Trespass-Härte, OE-33):** Edits **in jedem gewählten
> Stream-Kontext** (`repoRoot` wie Sub-Agent-Worktree) sind erlaubt (OE-35, unten). Offen bleibt nur:
> Soll mads beim **genuinen Region-Trespass** (Editieren einer Datei, die ein **anderer** Stream
> besitzt, §5.3) nur **warnen** oder den Save **hart sperren**? *(offen; Default gesetzt)*
> **Default: erlauben + warnen** (rote Leiste, §5.3) — der Mensch bleibt souverän; harte Sperre wäre
> paix-konformer, aber bevormundend. Review legt fest. **Abgrenzung:** das betrifft **nicht** den
> Worktree-Kontext selbst (der ist informativ, OE-35), sondern nur fremde-Region-Overlaps.

> **OFFENE FRAGE (Read-Cap-Größe, OE-34):** Konkrete Schwellen für Datei-/Verzeichnis-/Bild-Caps
> (Vorschlag: 2 MB Text, 2000 Einträge, 5 MB Bild) — empirisch zu kalibrieren; bei Überschreitung
> **immer** sichtbarer Hinweis + Opt-in-Vollload bzw. Binär-Fallback, nie still abschneiden (§6).

> **ENTSCHIEDEN (Worktree-Browsing-Schreibrechte, OE-35):** Das **Browsen UND Editieren eines
> Sub-Agent-Worktrees ist ein unterstützter First-Class-Flow** (§0/§1.2), **nicht** read-only. Ein per
> Stream-Kontext-Selector gewählter Worktree wird im Core **identisch** zu `repoRoot` registriert
> (`mads_register_root` → `allow_directory`, §4.2/§4.3) und ist damit lesbar **und schreibbar**. Der
> Kern-Use-Case verlangt es: ein Sub-Agent schreibt eine `.md`, die **noch nicht auf `main`** ist —
> der Mensch muss sie **im Worktree dieses Streams** reviewen, editieren und speichern können
> ([[08-markdown-editor]]), bevor der reguläre PR/Merge-Weg ([[03-main-agent]]) sie nach `main` bringt.
> Statt read-first ist die Leitplanke jetzt **Awareness**: eine **informative** Worktree-Leiste
> („Stream X · noch nicht auf `main`", §5.3, **kein** Blocker), die echte Trespass-Warnung nur bei
> **fremder** Region (OE-33), und der nebenläufige-Agent-Write-Caveat (Stream pausieren oder im
> Leerlauf editieren; `watchImmediate` + mtime/hash-Conflict-Check schützen, §4.2/§5.3/§7).
> Die paix-Invarianten bleiben gewahrt: Speichern ist ein lokaler Disk-Write, **kein** Commit/PR/Merge
> — `main` erreicht die Änderung nur über den Integrator-Merge (§0-Invarianten 1–3).

---

## 12. Querverweise

- [[08-markdown-editor]] — GitHub-Style-Renderer (Vorschau) + MD-Editor (Edit) für `.md`.
- [[09-change-overview]] — geteilter Region-/Diff-Datenfluss; Sub-Agent-Worktree-Browsing & -Editieren.
- [[10-navigation-toolbar]] — Activity-Rail; `activeView`/`PrimaryPanel`-Mount; Einstiegspunkt „Dateien"; LAYOUT-CONTRACT (kein persistentes Sidebar, eigener Panel-Stream-Selector).
- [[06-ownership-and-coordination]] — `detectTrespass`/`Collision`/`OwnershipRule` für die Trespass-Warnung (fremde Region).
- [[02-dashboard]] — Layout-Geschwister (Rail | Primary-Panel | `.main`), `StatusDot`/`STATUS_META`, Virtualisierung, A11y/Reduced-Motion.
- [[01-architecture]] — Schicht-Invarianten, Capability-Modell, IPC-Topologie.
- [[03-main-agent]] — der Integrator merged; menschliche Edits gehen denselben Gate-Weg.
- [[04-sub-agents]] — Worktree-Isolation (`~/mads-worktrees/<repo-slug>/<agentId>`).
- [[tauri2-stack]] — `tauri-plugin-fs`, Capabilities/Scope, `FsExt`-Laufzeit-Scope.
- [[macos-design]] — Sidebar/Content-Material, Vibrancy-Caveat (opaker Editor), HIG-Shortcuts.

---

## Offene Fragen (für den Review gesammelt)

1. ✅ **ENTSCHIEDEN — FS-Transport** (§4.1, OE-31): über den Rust-Core, nicht den Sidecar.
2. ✅ **ENTSCHIEDEN — Command-Aufteilung** (§4.2, OE-32): Read/Write/Walk = Custom-Command,
   Watch = Plugin.
3. **Edit-Confinement / Trespass-Härte** (§5.3, OE-33): bei genuinem Trespass (fremde Region) nur
   warnen (Default) vs. Save hart sperren? (Betrifft **nicht** den eigenen Worktree-Kontext — OE-35.)
4. **Read-Cap-Größe** (§6, OE-34): konkrete Schwellen für Datei-/Verzeichnis-Caps kalibrieren.
5. ✅ **ENTSCHIEDEN — Worktree-Browsing & -Editieren** (§0/§1.2/§5.3/§11, OE-35): First-Class-Flow,
   Sub-Agent-Worktrees sind lesbar **und** schreibbar (informative Leiste statt read-only).
