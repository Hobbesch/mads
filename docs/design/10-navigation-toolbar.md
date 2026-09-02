# 10 — Navigations-Toolbar (Activity-Rail) (mads)

> Status: Design, implementierungsreif. Stand: 2026-06-22.
> Sprache: Deutsch (Code/Identifier englisch).
> Quellen: [[macos-design]] (Sidebar/Material/Vibrancy/Shortcuts), [[02-dashboard]] §2
> (Gesamtanordnung), Frontend-Ist-Stand (`src/App.tsx`, `src/components/Sidebar.tsx`,
> `src/components/AgentGrid.tsx`, `src/App.css`). Versionsbezüge (`lucide-react`) sind gegen
> `package.json` zu verifizieren. README-Integration: Index-Zeile, „Design-Dokumente"-Zählung,
> Glossar (Activity-Rail / Primary-Panel / ToolbarItem-Registry / `activeView`) und die
> konsolidierte OE-Liste (OE-49..OE-52, Gruppe „Navigations-Toolbar (Doc 10)") sind mit diesem
> Doc gepflegt; Cross-Ref-Zeilen in [[01-architecture]] §0 und [[02-dashboard]] §0 ergänzt.

---

## 0. Zusammenfassung & Einordnung

Die **Activity-Rail** (Code-Identifier `ActivityRail`, `.activity-rail`; benutzerseitig
**Navigations-Toolbar**) ist die **äußerste Leiste links** im mads-Hauptfenster. Sie führt die
zentralen Hauptfunktionen als **Icon + Text** (aufgeklappt) bzw. **nur Icon mit Tooltip**
(zugeklappt) und ist der **einzige Umschalter** für das **Primary-Panel** — den
**aktivitäts-spezifischen** Mittel-Slot rechts neben ihr: Dateien ([[07-file-explorer]]),
Change-Overview ([[09-change-overview]]), Einstellungen, About und optional der Update-Bereich
([[05-update-area]]).

**Wichtige Design-Entscheidung dieses Docs (siehe §1a „Kritische Analyse"):** Die heutige
persistente **Stream-Sidebar (`src/components/Sidebar.tsx`) wird aufgelöst**, nicht eingerahmt.
Ihre Stream-/Sub-Agent-Liste **dupliziert** den `AgentGrid` (`src/components/AgentGrid.tsx`) im
Content und ist damit redundant; ihre Unikat-Elemente (Recent-Projects, „+ Neuer Stream", Brand/
About, Sidecar-Status) wandern in die Rail bzw. ihre Popover (§1a). Damit gilt das
**zweigliedrige** Standard-Layout des Dashboards:

```
[ Activity-Rail | Content (AgentGrid + Inspector) ]            ← Default-View "streams": KEIN Mittel-Panel
[ Activity-Rail | Primary-Panel | Content (AgentGrid + Inspector) ]  ← View "files"/"settings": Mittel-Panel aktiv
[ … + ChangeOverlay (position:fixed über .app) … ]            ← „Änderungen": Overlay, koexistiert mit jeder View
```

Das Primary-Panel ist also **kein persistenter Mittel-Streifen**, sondern erscheint **nur**, wenn
eine aktivitäts-spezifische Funktion (Dateien/Settings) aktiv ist — exakt das
Activity-Bar→Side-Bar→Editor-Muster aus VS Code und das Navigator-Modell aus Xcode (§1a, Quellen).
(„Änderungen" ist davon ausgenommen: es ist ein `position:fixed`-Overlay, kein Mittel-Panel — §2.3,
[[09-change-overview]] §1.4.)
Im Default-Streams-View ist das Herz die `Content`-Säule (`.main`) mit `AgentGrid` + `Inspector`;
die Rail steht direkt daneben.

Welches Primary-Panel (falls eines) gerendert wird, steuert ein einziges neues Store-Feld
`activeView`; `"streams"` bedeutet **kein** Primary-Panel. Die Rail selbst hat **keinen
Backend-Bedarf** — sie ist reine Zustands-Auswahl. Backend-Bedarf entsteht erst in den Panels, die
sie aktiviert (Dateien/Changes), und ist dort spezifiziert ([[07-file-explorer]], [[09-change-overview]]).

mads ist **reine Anzeige- und Steuer-Schicht** im Frontend (CLAUDE.md §„Schichten"): die Rail
**rendert State und sendet User-Intent** — keine Prozesse, keine Secrets, kein git/gh, **kein
direkter Festplattenzugriff**. Jeder Dateizugriff der von ihr aktivierten Panels läuft **durch den
Rust-Core** (`tauri-plugin-fs` mit gescopten Capabilities bzw. mads-eigene `#[tauri::command]`s),
nie aus dem WebView heraus — siehe §4/§5 und [[07-file-explorer]]. Die Rail berührt **keine** der
fünf Kern-Invarianten direkt (kein Merge, kein Branch, kein State-Store), bewahrt sie aber: das
einzige Panel mit Merge-Aktionen bleibt das Integrator-Panel im Content/Inspector ([[02-dashboard]] §7,
paix §2), und außen-sichtbare Aktionen bleiben explizit in den Panels, nicht in der Rail.

**Querverweise (andere Design-Docs):**

| Dokument | Beziehung zu diesem Dok |
|---|---|
| [[02-dashboard]] | Gesamtanordnung. Der Default-Streams-View ist **Rail + Content (AgentGrid + Inspector)** — **ohne** persistente Sidebar; das `AgentGrid` ist die Stream-Liste (es gab keine zweite). Dieses Doc löst die alte Sidebar auf; [[02-dashboard]] §2 ist entsprechend angepasst. |
| [[07-file-explorer]] | Panel hinter `activeView === "files"`; liefert FS-Anbindung (tauri-plugin-fs), die diese Rail nur **aktiviert**, nicht implementiert. Mountet im **Mittel-Slot**, der im Streams-View leer ist (§1a, LAYOUT-CONTRACT). |
| [[09-change-overview]] | **Overlay** hinter dem Rail-Toggle „Änderungen" (`changeOverviewOn`, **kein** `activeView`-Panel — §09 §1.4); trägt das Kollisions-Badge, das die Rail auf dem Changes-Eintrag spiegelt. |
| [[05-update-area]] | Optionaler Rail-Eintrag (Update-Bereich); Update-DB liegt im Core (OE-27), die Rail zeigt nur ein Badge bei verfügbarem Update. |
| [[01-architecture]] | Schicht-Grenzen (Frontend rein UI), Event-Topologie (OE-5), Capability-/Core-Modell. |
| [[macos-design]] | Token, Sidebar-Material/Vibrancy, Fokus-Ring, Traffic-Light-Abstand, Shortcut-Konventionen. |

**paix-Invarianten (in dieser Rail bewahrt, nicht berührt):**

1. **Only `main` merges.** Die Rail wechselt nur Panels; Merge-Aktionen leben ausschließlich im
   Integrator-Panel ([[02-dashboard]] §7), nie in einem Rail-Eintrag.
2. **`main` is always runnable.** Kein Rail-Eintrag löst Git-/Merge-Effekte aus.
3. **Subs never self-merge / außen-sichtbare Aktionen explizit.** Die Rail ist Navigation, keine
   Aktion mit Außenwirkung — push/pr/merge bleiben in den Panels, explizit.

---

## Kritische Analyse: Braucht es das Primary-Panel? (§1a)

> Diese Sektion hält die Design-Review-Entscheidung fest: **Die persistente Stream-Sidebar wird
> aufgelöst.** Das Primary-Panel bleibt als Layout-Slot bestehen, ist aber **kein persistenter
> Mittel-Streifen mehr**, sondern **rein aktivitäts-spezifisch** (Dateien/Changes/Settings). Sie
> ersetzt die frühere Annahme dieses Docs („die Rail rahmt die Sidebar ein") und ist die SSOT für
> 07/09 (siehe LAYOUT-CONTRACT am Doc-Ende).

### a.1 Der Auslöser: Redundanz Sidebar ↔ AgentGrid

Die heutige `Sidebar.tsx` rendert eine **Stream-Liste** (`StreamItem` je Agent: `StatusDot` +
`label` + `currentStep`, gruppiert in „Integrator" / „Sub-Agents · N" / „Erledigt · N"). Der
`AgentGrid.tsx` im Content rendert **dieselben Agenten** als Karten (`AgentCard`: dieselbe Ampel,
derselbe `label`, derselbe `currentStep`, plus Branch/Badges/Kosten). Beide lesen denselben
Store-Slice (`agents`/`order`), beide setzen über dieselbe Action `selectAgent` denselben
`selectedId`. Das ist **dieselbe Information, zweimal, nebeneinander** — die Sidebar-Liste ist eine
strikt **ärmere Teilmenge** der Grid-Karten. Genau diese Doppelung hat der Review als „REDUNDANT"
markiert, und sie ist real: nichts in der Sidebar-Stream-Liste sieht der Nutzer nicht schon (reicher)
im Grid.

### a.2 Best-Practice-Befund: das Side-Panel ist aktivitäts-abhängig, nie ein Content-Duplikat

Die drei kanonischen Vorbilder von mads (Developer-Tool-Klasse, [[02-dashboard]] §2) führen **alle**
dasselbe Muster — das Side-Panel ist **kontext-/aktivitäts-spezifisch** und **nie** eine statische
Kopie des Hauptinhalts:

- **VS Code (Activity-Bar → Side-Bar → Editor):** „The Activity Bar lets you switch between views
  and gives you additional context-specific indicators." „The Primary Side Bar contains different
  views like the Explorer […]. When you select an activity in the Activity Bar, the corresponding
  view displays in this sidebar." Die Side-Bar zeigt **je nach gewählter Activity** Explorer,
  Suche, Source-Control, Run/Debug — **nie** einen Klon des Editors. (Quelle: VS Code Docs,
  *User interface* / *Activity Bar*.)
- **Xcode (Navigator-Area):** Der Navigator wird per **⌘1..⌘9** zwischen **neun verschiedenen
  Navigatoren** umgeschaltet (Project, Find, Issue, …) — „The Navigator area has nine tabs you can
  jump to by pressing Command-1 through Command-9." Der Navigator ist **aktivitäts-spezifisch**, nie
  eine Kopie des Editors. (Quelle: Xcode-Tour / Apple Xcode-Doku.)
- **macOS HIG (Sidebars):** „A sidebar enables app navigation and provides quick access to
  **top-level collections** of content […]. When people choose an item in a sidebar, the split view
  displays the item's details in a secondary pane […]." Und entscheidend: „When a data hierarchy is
  **deeper than two levels**, consider using a split view interface that **includes a content list
  between the sidebar items and detail view**." Die mittlere Liste ist also eine **Navigations-/
  Inhaltsliste**, die den Detail-View **speist** — kein Duplikat des Detail-Views. (Quelle: Apple
  HIG, *Sidebars* / *Navigation and search*.)

Gemessen daran ist die heutige mads-Sidebar ein **Anti-Pattern**: ein persistenter Mittel-Streifen,
der eine **Teilmenge des Contents dupliziert** statt eine aktivitäts-spezifische Navigation oder
einen Detail-Speiser zu bieten. mads hat **keine Zwei-Ebenen-Hierarchie** (Sidebar-Auswahl → andere
Detail-Liste): die Stream-Auswahl füttert direkt den `Inspector` — und das Grid ist bereits die
„content list". Eine mittlere Stream-Liste **zwischen** Rail und Grid hätte keinen Job.

### a.3 Inventar: jedes Element der Sidebar, einzeln entschieden

| Element (in `Sidebar.tsx`) | Redundant mit AgentGrid/Inspector? | Entscheidung — wohin |
|---|---|---|
| **Stream-Liste** (`StreamItem` × N, Gruppen Integrator / Sub-Agents / Erledigt) | **Ja, vollständig.** Ärmere Teilmenge der `AgentCard`s; gleicher `selectAgent`/`selectedId`. | **Entfällt.** Der `AgentGrid` *ist* die Stream-Liste. Die „Erledigt · N"-Gruppe (`pr.state === "MERGED"`, heute nur in der Sidebar) wandert als **kollabierte Sektion ins Grid** ([[02-dashboard]] §3 Sortier-Sektionen) — kein Funktionsverlust. |
| **Sub-Agents-Zähler** (`Sub-Agents · 3`) | Ja (ableitbar aus dem Grid). | **Entfällt** als Liste; das Aggregat lebt schon im Titlebar-Header ([[02-dashboard]] §2 „6 agents …") und als **Rail-Badge** auf „Streams" (Eskalations-Count). |
| **Recent-Projects-Box** (`.recent-box`, `recentProjects`) | **Nein — unikat.** Nicht im Grid/Inspector. | **Rail-Eintrag „Projekt" → `RecentProjectsPopover`** (§1.3). Persistenz unverändert `src/recent.ts`. |
| **Project-Box** (aktueller `owner/repo`, „öffnen/wechseln") | Teilweise: `owner/repo` ist auch eine Titlebar-Pill ([[02-dashboard]] §2). „öffnen/wechseln" ist unikat. | **Rail-Eintrag „Projekt"** (Klick = Popover mit „Projekt öffnen…" + Recent). Die `owner/repo`-Pill in der Titlebar bleibt; der aktive Projekt-Name steht als Popover-Kopf. |
| **„+ Neuer Stream"-Button** | Bereits doppelt (Sidebar **und** Titlebar `+ Neuer Stream`). | **Rail-Aktion „Neuer Stream"** (`onNewStream`); Titlebar-Variante bleibt als Schnellzugriff (OE-52, kein Doppel-SSOT — beide rufen dieselbe Action). |
| **Brand / Logo** (Klick = About) | Nein. | **Rail-Kopf** (Logo oben in der Rail); Klick weiter „Über mads" (`onAbout`, §2.3). |
| **About-Eintrag** | Nein. | **Rail-Aktion „Über mads"** (unten angedockt, öffnet bestehendes `AboutDialog`-Overlay). |
| **Sidecar-Status-Foot** (`Sidecar: bereit · SDK ok`, Rückfrage-/Eskalations-Badges) | Teilweise: Eskalations-/Rückfrage-Zähler werden Rail-Badges; der Sidecar-Health-Text ist unikat. | **Sidecar-Health** → **Statusleiste** ([[02-dashboard]] §2, „◷ Sidecar OK") bzw. unten in der Rail als Mini-Dot; **Badges** → Rail-Badge auf „Streams". |

**Fazit des Inventars:** **Kein** Sidebar-Element braucht einen persistenten Mittel-Streifen. Die
**redundanten** Teile (Stream-Liste, Zähler) entfallen; die **unikaten** Teile (Recent-Projects,
Projekt-Wechsel, Neuer-Stream, Brand/About, Sidecar-Health) sind **kleine, punktuelle** Funktionen,
die natürlich in die **Rail / ihre Popover / die Titlebar / die Statusleiste** gehören — alles
Orte, die ohnehin existieren oder von diesem Doc eingeführt werden.

### a.4 Das Primary-Panel über alle Views — bleibt es ein Slot?

| `activeView` | Primary-Panel-Slot | Begründung |
|---|---|---|
| **`streams`** (Default) | **leer** — kein Mittel-Panel | Das Grid+Inspector ist der Content; eine mittlere Stream-Liste wäre das Duplikat (a.1/a.2). |
| **`files`** ([[07-file-explorer]]) | **Datei-Baum** (aktivitäts-spezifisch) | Klassisches Master-Detail: Baum speist die Preview/den Editor. Genau der HIG-„content list"-Fall (a.2). |
| **„Änderungen"** ([[09-change-overview]]) | **kein Primary-Panel** — `position:fixed`-Overlay | Toggle (`changeOverviewOn`), **nicht** `activeView`; koexistiert mit jeder View (OE-41, §09 §1.4). |
| **„Konflikt lösen"** | **kein Primary-Panel** — Bestätigungs-Dialog | Aktion (`kind:"action"`), keine View. Hält alle Sub-Streams an und übergibt an den Integrator (§a.7). |
| **`settings`** | **Settings-Panel** | Aktivitäts-spezifisch (Autonomie/Modelle/Permission-Defaults). |
| geplant (`updates`, Plugins) | je eigenes Panel | Registry-getrieben, je Feature (§3.2). |

Das Primary-Panel ist also **als Slot sinnvoll**, aber **nur aktivitäts-getragen**. Es als
*persistenten* Streifen zu führen (alte Annahme) war der Fehler; als *bedarfsweise* Spalte für
genau die Views, die eine zweite Navigations-/Inhaltsebene brauchen, ist es korrekt und
best-practice-konform.

### a.7 „Konflikt lösen" — die einzige übergreifende Aktion der Rail

Alle anderen Rail-Einträge wechseln eine Ansicht. Dieser eine greift in **alle Streams
gleichzeitig** ein, und genau darum steht er hier statt am einzelnen Stream.

**Warum nicht per Stream** (der Zustand bis 2026-08-28): Der frühere Inspector-Knopf
„Konflikt lösen" schickte nur einen Prompt in den betroffenen Sub-Stream. Der läuft aber
gesandboxt (`sidecar/src/sandbox.ts`) und darf ausschliesslich in seinen eigenen Worktree
schreiben — andere Worktrees unter `~/mads-worktrees/…` sind für ihn unerreichbar. Damit kann er
`git merge-tree` zwischen zwei Branches, einen Hunk-Vergleich oder die Frage „welcher Branch
zuerst?" **prinzipiell nicht** beantworten. Er rebaset blind, während die übrigen Streams
weiterarbeiten und die Lage erneut verschieben.

**Was der Knopf stattdessen tut** (`panic_resolve`, `shared/protocol.ts`):

1. Alle Sub-Streams anhalten und ihren Autopilot auf `manual` setzen — nichts verschiebt sich
   mehr, während gemessen wird. Der vorherige Level wird gemerkt.
2. Den **Integrator** beauftragen: der einzige Stream ohne Sandbox, im `repoRoot`, mit Sicht auf
   alle Worktrees — und per Invariante 1 ohnehin der Einzige, der mergen darf. Er braucht dafür
   **keine zusätzlichen Rechte**; die Verlagerung allein löst das Problem.
3. Er bekommt das Playbook (`sidecar/playbooks/conflict-resolution.md`) plus einen Lagebericht
   über alle Streams. Merge nach main nur nach menschlicher Rückfrage.
4. Freigabe ist ein eigener, menschlicher Schritt (`panic_release`) — derselbe Rail-Eintrag
   wechselt dafür zu „Streams fortsetzen".

Das Badge zählt **Streams** in Konfliktlage (`conflictCount` in `src/derive.ts`), nicht Meldungen:
ein einzelner Trespass-Alarm feuert im Autopilot dutzendfach, eine zweistellige Zahl an der Rail
wäre irreführend.

### a.5 Die Entscheidung

> **ENTSCHIEDEN (Auflösung der persistenten Sidebar, OE-52 revidiert):** Der Streams-/Dashboard-View
> ist **[Activity-Rail | Content (AgentGrid + Inspector)]** — **ohne** Mittel-Panel. Die persistente
> `Sidebar.tsx` wird **aufgelöst**; ihre redundante Stream-Liste entfällt (das Grid ist die Liste),
> ihre Unikat-Elemente wandern in Rail/Popover/Titlebar/Statusleiste (a.3). Das Primary-Panel ist
> **rein aktivitäts-spezifisch** (Dateien/Settings) und erscheint nur bei
> `activeView ∈ {files, settings, …}`. `activeView === "streams"` rendert **kein**
> Primary-Panel. **„Änderungen" ist kein Primary-Panel-View**, sondern ein `position:fixed`-Overlay
> (`changeOverviewOn`, [[09-change-overview]] §1.4) und daher **nicht** Teil der `ViewId`-Union.

### a.6 Trade-off: Agenten-Bewusstsein außerhalb des Dashboards

Mit aufgelöster Sidebar ist die Stream-Liste nicht mehr **immer** sichtbar. Das ist HIG-konform
(das Side-Panel war ohnehin nie für ständige Content-Spiegelung gedacht, a.2), erfordert aber eine
bewusste Lösung für die situative Awareness, wenn der Nutzer im Files-/Changes-/Settings-View ist:

1. **Live-Badge auf dem Rail-Eintrag „Streams"** (`escalations.length`, §3.2/§3.3): rote Zahl bei
   Eskalation, gelb bei offenen Rückfragen — sichtbar **in jedem View**, auch kollabiert
   (ins `aria-label` eingebettet, §8). Das ist der primäre „etwas braucht dich"-Anker off-dashboard.
2. **Schneller Rücksprung** per **⌘1** (oder Klick auf „Streams") — ein Tastendruck zurück zum Grid.
   Kein verschachtelter Navigationspfad.
3. **Native Notification + Dock-Badge** bei Zustandswechsel (bereits in [[02-dashboard]] §4) — die
   Eskalation/Rückfrage poppt unabhängig vom aktiven View.
4. **Optionaler dockbarer Inspector / Detach-to-Window (Post-MVP):** ein Fokus-Agent kann als
   eigenes Fenster abgedockt werden ([[02-dashboard]] §9.1, OE-3) — wer dauerhaft einen Agenten im
   Blick behalten will, dockt ihn ab, statt eine globale Sidebar zu erzwingen.

Damit ist die Awareness **gezielt** (Badge + Notification + 1-Tasten-Rücksprung) statt **permanent
gespiegelt** — genau die HIG-/VS-Code-Logik: das Side-Panel ist Navigation, der Alarm sitzt auf dem
Navigations-Icon, der Inhalt bleibt im Content.

---

## 1. UX & Interaktionsdesign

### 1.1 Zustände der Rail

Die Rail hat **zwei orthogonale Zustands-Achsen**:

1. **Kollaps-Achse** — `railCollapsed: boolean` (persistiert):
   - **aufgeklappt** = Icon **+ Text-Label** (Breite ~176 px),
   - **zugeklappt** = **nur Icon** + nativer Tooltip beim Hover/Focus (Breite ~52 px).
2. **Aktiver-Eintrag-Achse** — `activeView: ViewId` (persistiert): genau **ein** Eintrag ist
   `aria-current="true"`/`.active`. Bei `activeView ∈ {files, settings, …}` wird sein Panel
   im Primary-Panel-Slot gerendert; bei `activeView === "streams"` (Default) **erscheint kein
   Primary-Panel** — der `Content` (AgentGrid + Inspector) steht direkt neben der Rail (§1a.5). Der
   „Änderungen"-Eintrag ist kein Panel-Selektor, sondern ein Aktions-Toggle: er ist `.active`,
   solange `changeOverviewOn` (das Overlay), nicht an `activeView` gebunden (§2.3). (`"true"`
   statt `"page"`, weil mads ein Ein-Fenster-/Router-loses Modell ist (FRONTEND MAP: „No router —
   single screen") und die Rail In-App-**Panels** umschaltet, keine navigierten Seiten/URLs — §8.)

Pro Eintrag: `default` (idle), `hover`, `:focus-visible` (sichtbarer Fokus-Ring), `active`
(aktiver Eintrag), `disabled` (z.B. „Dateien"/„Changes" ohne offenes Projekt → `project == null`),
optional mit **Badge** (z.B. Eskalations-Count) overlagert.

### 1.2 Flows

- **Panel wechseln:** Klick auf Eintrag **oder** `⌘1..⌘n` → `setActiveView(id)`. Der vorige
  Panel-Inhalt wird unmontiert/ersetzt; bei `activeView === "streams"` wird **gar kein** Mittel-Panel
  montiert (§1a.5). Der `Content` (AgentGrid + Inspector) bleibt **immer** sichtbar, weil er das Herz
  des Dashboards ist (siehe §1.4). `⌘1` ist damit der schnelle Rücksprung zum Grid (§1a.6).
- **Rail kollabieren/expandieren:** Klick auf den unteren **Chevron-Toggle** (`«`/`»`) **oder**
  Shortcut **⌃⌘B** → `toggleRailCollapsed()` → persistiert sofort.
- **Projekt öffnen/wechseln:** Eintrag „Projekt" öffnet den **Recent-Projects-Switcher** (ein
  Popover, das `src/recent.ts` wiederverwendet) bzw. ruft `openProject()` (Folder-Picker via
  `@tauri-apps/plugin-dialog`, schon vorhanden). Siehe §1.3.
- **Neuer Stream:** Eintrag „Neuer Stream" ruft den vorhandenen `NewStreamDialog`-Callback (heute
  `onNewStream` aus `App.tsx`) — er ist eine **Aktion**, kein Panel (Sonderfall, §2.3).
- **Einstellungen / About:** öffnen ihr jeweiliges Primary-Panel (Settings) bzw. den vorhandenen
  `AboutDialog` (About bleibt ein Overlay — Sonderfall, §2.3).

### 1.3 Recent-Projects-Switcher (Wiederverwendung `src/recent.ts`)

Der Projekt-Eintrag öffnet ein kleines Popover direkt rechts neben der Rail. Es **übernimmt** die
Recent-/Projekt-Funktion der aufgelösten Sidebar (`.recent-box` + `.project-box` aus `Sidebar.tsx`,
§1a.3): es zeigt `recentProjects` (aus dem Store, localStorage-backed via
`loadRecentProjects`/`rememberProject`/`forgetProject`), filtert das aktive Projekt heraus
(`r.repoRoot !== project?.repoRoot`, exakt wie zuvor), und bietet pro Eintrag `openRecentProject(repoRoot)`
sowie `forgetRecentProject(repoRoot)`. Kopf des Popovers: der aktive `owner/repo` (bisher
`.project-name`). Oberster Eintrag: „Projekt öffnen…" → `openProject()`. **Keine neue
Persistenz-Logik** — `recent.ts` bleibt unverändert SSOT der Recent-Liste; die markup-Bausteine
werden lediglich aus `Sidebar.tsx` in `RecentProjectsPopover.tsx` umgehängt.

### 1.4 ASCII-Layout-Skizzen (aufgeklappt)

**Default-View `streams` — KEIN Mittel-Panel** (Rail + Content). Das `AgentGrid` *ist* die
Stream-Liste; es gibt keine zweite:

```
┌──────────────┬────────────────────────────────────────────────────────────────────────┐
│ ACTIVITY-RAIL│   CONTENT (.main)                                                        │
│ (~176px,     │  ┌ .titlebar (drag-region, traffic-light-safe) ───────────────────────┐ │
│  vibrancy)   │  │ Dashboard · 6 agents   [v-pill][repo-pill][toggles][↻][+ Neuer]     │ │
│ ◀ mads-Logo  │  └────────────────────────────────────────────────────────────────────┘ │
│   (→ About)  │  ┌ .body ──────────────────────────────────────────────────────────────┐│
│              │  │ .center (AgentGrid)            │   Inspector                          ││
│ ◆ Streams ②  │  │  ┌────┐ ┌────┐ ┌────┐         │   chat timeline (MessageTimeline)    ││
│ ▤ Dateien    │  │  │card│ │card│ │card│         │   + composer                         ││
│ ⛁ Changes  ④ │  │  └────┘ └────┘ └────┘         │                                      ││
│ ⟳ Updates  ● │  │  ── Erledigt · N (kollabiert) │                                      ││
│ ─────────    │  │                                │                                      ││
│ + Neuer Str. │  └──────────────────────────────────────────────────────────────────────┘│
│ ─────────    │                                                                          │
│ ⚙ Einstell.  │                                                                          │
│ ⓘ Über mads  │                                                                          │
│ « (collapse) │                                                                          │
└──────────────┴────────────────────────────────────────────────────────────────────────┘
```

**Aktivitäts-View `files`/`settings` — Mittel-Panel aktiv** (Rail + Primary-Panel +
Content). Nur dann erscheint der Mittel-Slot (`„Änderungen"` belegt **keinen** Slot — Overlay):

```
┌──────────────┬──────────────────────┬────────────────────────────────────────────────┐
│ ACTIVITY-RAIL│   PRIMARY-PANEL       │   CONTENT (.main)                                │
│              │  (aktivitäts-         │  ┌ .titlebar ───────────────────────────────────┐│
│ ◆ Streams ②  │   spezifisch:         │  │ Dashboard            [pills][toggles][+ New] ││
│ ▤ Dateien ◀  │   FileExplorer /      │  └──────────────────────────────────────────────┘│
│ ⛁ Changes  ④ │   SettingsPanel)      │  ┌ .body ──────────────────────────────────────┐│
│ ⟳ Updates  ● │   (Änderungen =       │  │ .center (AgentGrid)   │   Inspector          ││
│ + Neuer Str. │    Overlay, nicht     │  │  ┌────┐ ┌────┐        │   chat timeline      ││
│ ⚙ Einstell.  │    hier)              │  │  │card│ │card│        │   + composer         ││
│ ⓘ Über mads  │  ▾ src/               │  │  └────┘ └────┘        │                      ││
│ « (collapse) │    ▾ components/      │  │                       │                      ││
└──────────────┴──────────────────────┴────────────────────────────────────────────────┘
       ↑ „Änderungen" (⇧⌘D) öffnet stattdessen das ChangeOverlay (position:fixed über .app, §09 §2.1)
```

> Hinweis: Das `Content` (AgentGrid + Inspector) bleibt **in beiden** Views sichtbar (§1.4-Regel:
> Grid ist das Herz). Die Eskalations-/Rückfrage-Awareness im `files`/`settings`-View kommt über das
> **Badge auf „Streams"** (②/④) + Notification + `⌘1`-Rücksprung (§1a.6), nicht über eine
> persistente Stream-Liste.

Zugeklappt schrumpft die linke Spalte auf ~52 px (nur Icons + Tooltip), der Rest verschiebt sich
nach links.

### 1.5 macOS-HIG-Bezüge

- **Traffic-Light-Abstand:** `titleBarStyle: "Overlay"` ist gesetzt (`src-tauri/tauri.conf.json`),
  `hiddenTitle: true`. Die Ampel-Buttons liegen oben links **über** der Rail. Die Rail muss daher
  oben einen Sicherheitsabstand haben — sie **übernimmt** den oberen Versatz der aufgelösten Sidebar
  (`padding: 30px 12px 12px` in `.sidebar`, `src/App.css`, → `.activity-rail { padding-top: 30px }`),
  und ihr oberster Eintrag (mads-Logo) beginnt **unterhalb** des Ampel-Streifens.
- **Material/Vibrancy:** Die Rail **erbt den Sidebar-Look** — translucentes `--sidebar-bg` +
  `backdrop-filter: blur(28px) saturate(180%)` (die bisherigen `.sidebar`-Regeln in `src/App.css`
  ziehen auf `.activity-rail` um; die Sidebar-spezifischen Klassen werden mit `Sidebar.tsx` entfernt
  bzw. in Rail/Popover umgewidmet). Bei `prefers-reduced-transparency: reduce` → solider Hintergrund
  ([[macos-design]], analog [[02-dashboard]] §11).
- **Drag-Region:** Die Rail trägt `data-tauri-drag-region` (wie zuvor `.sidebar`), ihre Buttons sind
  via globalem `[data-tauri-drag-region] button { app-region: no-drag }` (`src/App.css`) klickbar.
- **Fokus-Ring:** `:focus-visible` mit `--accent`-Ring (native Anmutung).

---

## 2. Komponenten-Architektur

### 2.1 Neue React-Komponenten (passend zu `src/components/`)

Alle neuen Komponenten sind **reines UI**. Sie konsumieren den Store via `useStore(...)` und senden
Intent über vorhandene Actions; sie sprechen **nie** IPC/FS direkt an.

| Komponente (Datei) | Verantwortung | Props |
|---|---|---|
| `ActivityRail` (`src/components/ActivityRail.tsx`) | Rendert die Rail aus der `TOOLBAR_ITEMS`-Registry; mads-Logo-Kopf (→ About); Kollaps-Toggle; mappt Klick/Shortcut auf `setActiveView`/Aktion. **Absorbiert** die Aktions-/Brand-Rolle der aufgelösten `Sidebar`. | `{ onNewStream: () => void; onAbout: () => void }` (Aktions-Einträge, wie zuvor an `Sidebar`). |
| `ActivityRailItem` (`src/components/ActivityRailItem.tsx`) | Ein einzelner Eintrag: Icon (+ Label wenn nicht kollabiert), Tooltip wenn kollabiert, Badge, `aria-current`, `disabled`. | `{ item: ToolbarItem; active: boolean; collapsed: boolean; badge?: number \| "dot"; disabled?: boolean; onActivate: () => void }` |
| `PrimaryPanel` (`src/components/PrimaryPanel.tsx`) | Switch über `activeView` → rendert das jeweilige aktivitäts-spezifische Panel. **Bei `activeView === "streams"` rendert es `null`** (kein Mittel-Panel, §1a.5). | — (liest `activeView` selbst). |
| `RecentProjectsPopover` (`src/components/RecentProjectsPopover.tsx`) | Recent-/Projekt-Switcher (§1.3), **übernimmt** `.recent-box` + `.project-box` aus `Sidebar.tsx`; wiederverwendet `recentProjects`/`openRecentProject`/`forgetRecentProject`/`openProject`. | `{ open: boolean; onClose: () => void }` |
| `SettingsPanel` (`src/components/SettingsPanel.tsx`) | Primary-Panel für `activeView === "settings"` (Autonomy-Toggles aus der Titlebar herziehbar; Platzhalter erweiterbar). | — |

> **Auflösung `Sidebar.tsx` (Bestands-Änderung):** Die Datei `src/components/Sidebar.tsx` und das
> `StreamItem`-Sub-Component **entfallen**. Die Stream-Liste ist redundant mit `AgentGrid.tsx`
> (§1a.1) — sie wird **nicht** portiert. Recent-/Projekt-Markup → `RecentProjectsPopover`; Brand/
> About/Neuer-Stream → Rail; Sidecar-Health-Foot → Statusleiste/Rail (§1a.3). Die zugehörigen
> `.sidebar*`/`.recent*`/`.project*`/`.stream*`-CSS-Regeln in `src/App.css` werden auf
> `.activity-rail`/Popover umgewidmet bzw. entfernt. **`AgentGrid.tsx` absorbiert** die heute nur
> in der Sidebar gezeigte „Erledigt · N"-Gruppe (gemergte Subs, `pr.state === "MERGED"`) als
> kollabierte Sektion ([[02-dashboard]] §3) — kein Funktionsverlust.

**Icon-Set-Entscheidung (siehe OE-49):** Empfehlung **`lucide-react`** für die Rail-Icons
(tree-shaken, konsistent, React-19-kompatibel — der Web-Pkg ist nur durch eine
konservativ formulierte Peer-Range „gewarnt", rendert aber problemlos). Der App-Stil rollt heute
SVGs selbst (`brand-logo` ist ein PNG, Status-Icons in `StatusDot.tsx`); die Rail ist der natürliche
Ort, das erste icon-set einzuführen, ohne Bestands-SVGs anzufassen. **`lucide-react` ist heute
*nicht* in `package.json`** — seine Einführung ist ein `package.json`/`package-lock.json`-Bump und
unterliegt damit dem Shared-File-/Lockfile-Protokoll (CLAUDE.md „Build & Gates"), genau wie 07/08
für ihre Deps notieren. Bis die Dep landet, kompilieren die `LucideIcon`-Referenzen in §3.2 nicht.

### 2.2 Einbau in das bestehende Layout (`src/App.tsx`)

Heute rendert `App.tsx` direkt:

```tsx
<div className="app">
  <Sidebar onNewStream={…} onAbout={…} />
  <div className="main">…</div>
  …overlays…
</div>
```

Neu wird die `Sidebar` **ersatzlos durch die Rail** abgelöst; das Primary-Panel ist eine **eigene
Spalte, die nur bei aktivem Aktivitäts-View Inhalt hat**. Die `.main`-Säule (Titlebar + Banner +
`.body` mit `AgentGrid`/`Inspector`) bleibt **unverändert**:

```tsx
<div className="app">
  <ActivityRail onNewStream={() => setShowNew(true)} onAbout={() => setShowAbout(true)} />
  <PrimaryPanel onNewStream={() => setShowNew(true)} onAbout={() => setShowAbout(true)} />
  {/* ↑ rendert FileExplorer | SettingsPanel — oder null bei "streams" (Changes ist KEIN Panel) */}
  <div className="main">…</div>  {/* bleibt: Titlebar, Banner, AgentGrid, Inspector */}
  {showNew && <NewStreamDialog … />}
  {showAbout && <AboutDialog … />}
  <PermissionDialog /> <ParallelDialog />
  <ChangeOverlay />  {/* [[09-change-overview]] §2.1 — position:fixed-Overlay, self-hides bei !changeOverviewOn */}
</div>
```

`PrimaryPanel` ist der Switch — **`streams` ist `null`** (kein Mittel-Panel, §1a.5):

```tsx
export function PrimaryPanel() {
  const view = useStore((s) => s.activeView);
  switch (view) {
    case "files":    return <FileExplorer />;     // [[07-file-explorer]]  — eigener Mittel-Slot
    case "settings": return <SettingsPanel />;
    case "streams":
    default:         return null;                 // KEIN Panel: Rail steht direkt neben .main
  }
  // NB: „Changes" ist KEIN Primary-Panel. Die Change-Overview ist ein `position:fixed`-Overlay
  //     über `.app` (`<ChangeOverlay/>`, [[09-change-overview]] §1.4/§2.1), gesteuert vom
  //     `changeOverviewOn`-Toggle — NICHT von `activeView`. Der Rail-Eintrag „Changes" ist daher
  //     ein `kind:"action"`-Toggle (→ `toggleChangeOverview`), kein Panel-Switch (§2.3, §3.2).
}
```

> **Wichtig (Bestands-Auflösung statt -Erhalt):** Die existierende `Sidebar.tsx` wird **aufgelöst**
> (§1a, §2.1-Callout), **nicht** zur `streams`-View gemacht. Ihre Stream-Liste ist redundant mit
> `AgentGrid.tsx`; ihre Unikat-Elemente (Recent/Projekt → `RecentProjectsPopover`, Brand/About/
> Neuer-Stream → Rail, Sidecar-Health → Statusleiste) ziehen um. Der `streams`-View ist damit **nur**
> Rail + `.main` (Grid + Inspector). Das respektiert OE-3 (eine-Fenster-MVP) und entfernt die vom
> Review beanstandete Doppelung — der Diff bleibt überschaubar, weil die Stream-Liste schlicht
> *gelöscht* statt umgehängt wird.

### 2.3 Sonderfälle: Aktions-Einträge vs. Panel-Einträge

Ein `ToolbarItem` ist entweder **panel-aktivierend** (`kind: "panel"`, setzt `activeView`) oder eine
**Aktion** (`kind: "action"`, ruft einen Callback, ändert `activeView` nicht):

- `kind: "panel"`: Streams, Dateien, Einstellungen, (Updates) — setzen `activeView`.
- `kind: "action"`: „Neuer Stream" (→ `onNewStream`), „Über mads" (→ `onAbout`, öffnet das
  bestehende `AboutDialog`-Overlay) und **„Änderungen"** (→ `toggleChangeOverview`, schaltet das
  `position:fixed`-`<ChangeOverlay/>`, [[09-change-overview]] §1.4/§2.1 — **kein** Panel-Switch).
  „Projekt" ist ein Sonderfall: Klick öffnet das `RecentProjectsPopover` (`kind: "popover"`).

> **Wichtig (Changes ≠ Panel):** Anders als „Dateien" (echtes Primary-Panel) ist „Änderungen"
> ein **Aktions-Toggle**. Der Eintrag ist `active`, solange `changeOverviewOn === true` (statt
> `activeView === id`), und das Overlay koexistiert mit **jeder** View (Streams-Grid wie
> Files-Panel) — es belegt **keine** Mittel-Spalte. Die Change-Overview ist [[09-change-overview]]s
> Owner-Entscheidung (OE-41: Overlay statt OS-Multi-Window); diese Rail spiegelt sie nur.

---

## 3. State & Datenfluss

### 3.1 Store-Erweiterungen (`src/store.ts`)

Die Rail braucht **zwei neue State-Felder** + drei Actions. Beides ist reine UI-Projektion, kein
Sidecar-State — daher **localStorage-persistiert** (analog `src/recent.ts`), nicht über das
NDJSON-Protokoll.

```typescript
// ── neue Typen (in src/store.ts oder src/views.ts) ────────────────────────────
export type ViewId = "streams" | "files" | "settings"; // erweiterbar (z.B. "updates")
// NB: KEIN "changes" — die Change-Overview ist ein Overlay (changeOverviewOn), kein activeView-Panel
// ([[09-change-overview]] §1.4/§2.1). Sie hat ihr eigenes Store-Feld changeOverviewOn (dort §3.2).

// ── Ergänzung an MadsState ────────────────────────────────────────────────────
interface MadsState {
  // … bestehende Felder (sidecar, project, agents, order, events, …) …
  activeView: ViewId;        // welcher Rail-View aktiv ist (persistiert).
                             // "streams" (Default) ⇒ KEIN Primary-Panel — nur Content (§1a.5);
                             // "files"/"settings" ⇒ aktivitäts-spezifisches Mittel-Panel.
                             // "changes" ist KEIN ViewId — Overlay via changeOverviewOn (§2.3).
  railCollapsed: boolean;    // Rail nur-Icon (true) vs. Icon+Text (false)  (persistiert)
  changeOverviewOn: boolean; // Change-Overview-Overlay an/aus ([[09-change-overview]] §3.2 — Owner).
                             // Hier nur referenziert: der Rail-„Changes"-Eintrag toggelt es (§2.3/§3.2).

  setActiveView: (view: ViewId) => void;
  toggleRailCollapsed: () => void;
  setRailCollapsed: (collapsed: boolean) => void;
}
```

> **Bestehende Store-Felder unverändert.** `recentProjects` (localStorage via `src/recent.ts`),
> `agents`/`order`/`selectedId`, `escalations`/`permissions`/`collisions` bleiben **wie sie sind** —
> die Auflösung der Sidebar **entfernt kein** Store-Feld; sie ändert nur, *wer* sie rendert
> (`RecentProjectsPopover` statt `Sidebar` für `recentProjects`; Rail-Badge statt Sidebar-Foot für
> `escalations.length`). Der `AgentGrid` las `agents`/`order` schon vorher — neuer Konsument der
> „Erledigt"-Gruppe, kein neues Feld. Das ist die kleinstmögliche State-Änderung: **nur**
> `activeView` + `railCollapsed` kommen hinzu.

Action-Skizzen (Set + sofortige Persistenz; analog zum Muster, mit dem `recent.ts` über `save()`
in localStorage schreibt):

```typescript
// kleine, lokale Persistenz-Helfer (neue Datei src/uiPrefs.ts, Stil von src/recent.ts)
const KEY = "mads.uiPrefs";
type UiPrefs = { activeView: ViewId; railCollapsed: boolean };
export function loadUiPrefs(): UiPrefs { /* try JSON.parse(localStorage[KEY]); Fallbacks */ }
function saveUiPrefs(p: UiPrefs): void { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch {} }

// in create<MadsState>(...):
activeView: loadUiPrefs().activeView,        // initial aus localStorage
railCollapsed: loadUiPrefs().railCollapsed,

setActiveView: (view) => {
  set({ activeView: view });
  saveUiPrefs({ activeView: view, railCollapsed: get().railCollapsed });
},
toggleRailCollapsed: () => {
  const next = !get().railCollapsed;
  set({ railCollapsed: next });
  saveUiPrefs({ activeView: get().activeView, railCollapsed: next });
},
setRailCollapsed: (collapsed) => {
  set({ railCollapsed: collapsed });
  saveUiPrefs({ activeView: get().activeView, railCollapsed: collapsed });
},
```

> **Begründung Persistenz-Ort:** Genau wie `recentProjects` (localStorage, nicht
> `agents.json`/SQLite) ist die Rail-Präferenz **app-weite UI-Vorliebe**, kein Agenten-State. Sie
> gehört damit **nicht** in die SSOT-Stores (Sidecar-Pool/`agents.json`/SQLite, Invariante 5) und
> verletzt die Single-Writer-Regel nicht — der Core spiegelt sie auch nicht. WKWebView-localStorage
> liegt unter `~/Library/WebKit/<bundle-id>/` und überlebt App-Updates (vgl. `src/recent.ts`-Doc).

### 3.2 ToolbarItem-Registry (Erweiterbarkeit)

Der Kern der „erweiterbaren Menüführung": eine **deklarative Registry**, an die künftige Features
einfach Einträge anhängen. Kein Code in `ActivityRail` muss sich ändern, um einen Eintrag zu ergänzen.

```typescript
// src/toolbarItems.ts — Single Source of Truth der Rail-Einträge
// type-only Imports (kein Runtime-Import → kein Import-Cycle toolbarItems↔store, kein
// lucide-react im reinen Logik-Pfad; siehe §9):
import type { LucideIcon } from "lucide-react";
import type { MadsState, ViewId } from "./store";   // bzw. "./views" für ViewId

export interface ToolbarItem {
  id: string;                                  // stabile id ("streams", "files", …)
  icon: LucideIcon;                            // lucide-react Icon-Komponente (OE-49)
  label: string;                               // deutscher Text (aufgeklappt sichtbar)
  order: number;                               // Sortierung in der Rail
  kind: "panel" | "action" | "popover";
  view?: ViewId;                               // nur bei kind === "panel"
  group?: "top" | "bottom";                    // "bottom" = unten angedockt (Settings/About)
  separatorBefore?: boolean;                   // optischer Trenner über dem Eintrag
  shortcut?: string;                           // Anzeige-Hinweis, z.B. "⌘1"
  enabled?: (s: MadsState) => boolean;         // z.B. (s) => !!s.project  → disabled ohne Projekt
  badge?: (s: MadsState) => number | "dot" | undefined; // z.B. Eskalations-Count
}

export const TOOLBAR_ITEMS: ToolbarItem[] = [
  { id: "project",  icon: FolderOpen, label: "Projekt",       order: 0, kind: "popover", group: "top" },
  { id: "new",      icon: Plus,       label: "Neuer Stream",  order: 1, kind: "action", group: "top", separatorBefore: true },
  { id: "streams",  icon: Boxes,      label: "Streams",       order: 2, kind: "panel", view: "streams", group: "top", shortcut: "⌘1",
    // "streams" rendert KEIN Primary-Panel (§1a.5) — der Content (AgentGrid+Inspector) ist die View.
    // Das Badge ist der zentrale Off-Dashboard-Awareness-Anker (§1a.6).
    badge: (s) => s.escalations.length || undefined },
  { id: "files",    icon: Files,      label: "Dateien",       order: 3, kind: "panel", view: "files", group: "top", shortcut: "⌘2",
    enabled: (s) => !!s.project },
  // „Änderungen" ist ein TOGGLE, kein Panel: es schaltet das ChangeOverlay (changeOverviewOn),
  // nicht activeView ([[09-change-overview]] §1.4/§2.1). Daher kind:"action" + active=changeOverviewOn.
  { id: "changes",  icon: GitCompare, label: "Änderungen",    order: 4, kind: "action", group: "top", shortcut: "⇧⌘D",
    enabled: (s) => !!s.project, badge: (s) => s.collisions.length || undefined },
  { id: "settings", icon: Settings,   label: "Einstellungen", order: 90, kind: "panel", view: "settings", group: "bottom", shortcut: "⌘," },
  { id: "about",    icon: Info,       label: "Über mads",     order: 91, kind: "action", group: "bottom" },
];
```

Ein künftiges Feature (z.B. Update-Bereich, [[05-update-area]]) fügt **eine Zeile** hinzu —
`{ id: "updates", icon: RefreshCw, label: "Updates", order: 5, kind: "panel", view: "updates", badge: (s) => s.updateAvailable ? "dot" : undefined }` — und einen `ViewId`-Eintrag.

### 3.3 Datenfluss

Reines UI: Klick/Shortcut → `setActiveView`/`toggleRailCollapsed`/Action-Callback. **Badges** sind
**abgeleitet** (`badge(s)`) aus bereits vorhandenem Store-State:

- Streams-Badge = `escalations.length` (zuvor im Sidebar-Foot als `.foot-badge red`,
  `Sidebar.tsx`; mit der Auflösung der Sidebar wird dieser Zähler zum **Rail-Badge auf „Streams"**
  und ist der zentrale Off-Dashboard-Awareness-Anker, §1a.6).
- Changes-Badge = `collisions.length` (heute schon im `.collision-banner`, `App.tsx`).
- Updates-Badge (Post-MVP) = ein neues, vom Core gespiegeltes „update verfügbar"-Flag
  ([[05-update-area]]).

Es entsteht **kein neuer Event-Pfad**: die Badges lesen denselben State, der schon über
`handleSidecarMessage` (Store) gepflegt wird (Collisions aus `collision_warning`, Escalations aus
`error`/`SidecarErrorMsg`). Keine Rail-seitige Koaleszenz nötig — die Werte ändern sich selten
(Sidecar-Poll-Takt, [[02-dashboard]] §8) und werden im Store nur als fertige Zähler gehalten
(`collisions`/`escalations`); die Rail liest sie über memoisierte Selektoren.

---

## 4. Protokoll- & Core-Anbindung

### 4.1 `shared/protocol.ts` — Bedarf der Rail selbst: **keiner**

Die Rail ist Navigation; sie führt **keine** neuen Nachrichten-Typen ein. `shared/protocol.ts`
bleibt unverändert für dieses Feature. Das ist beabsichtigt: jede Panel-Daten-Anbindung gehört in
das jeweilige Panel-Doc, nicht in die Rail.

Der **einzige** denkbare zukünftige Protokoll-Touchpoint ist das **Updates-Badge** (Post-MVP), das
ein vom Core gespiegeltes Flag braucht. Falls es kommt, lebt der Typ in `shared/protocol.ts` als
SSOT (beide Seiten importieren), z.B.:

```typescript
// NUR falls Updates-Eintrag realisiert wird — gehört primär in [[05-update-area]]
export interface UpdateStatusMsg extends BaseMsg {
  type: "update_status";
  available: boolean;          // → Rail-Badge "dot"
  latestVersion?: string;
}
// in der SidecarMessage-Union ergänzen; im Store ein Feld `updateAvailable: boolean` spiegeln.
```

### 4.2 tauri-plugin-fs — von der Rail **aktivierte**, nicht von ihr definierte Capability

Die Rail selbst braucht **keine** neuen Capabilities (sie liest nur Store-State). Sie aktiviert aber
das Dateien-Panel ([[07-file-explorer]]), dessen FS-Zugriff **durch den Rust-Core** läuft. Damit das
Dateien-Panel überhaupt erreichbar ist, muss die Capability-Erweiterung existieren — sie wird hier
aber **nicht dupliziert**, um Drift zu vermeiden:

> **Capability/Scope siehe [[07-file-explorer]] §4/§5 (dort verbatim, Owner).** In Kurzform: eine neue
> `src-tauri/capabilities/fs.json` (`mads-fs`) mit **`fs:allow-watch`** (nur der Watch läuft über das
> Plugin) + einem `fs:scope`-Block. **Read/Write/Dir-Walk laufen NICHT über Plugin-Permissions,
> sondern über mads-eigene `#[tauri::command]`s** (`mads_read_dir`/`mads_read_file`/`mads_write_file`,
> OE-31/OE-32 entschieden) — daher **keine** `fs:allow-read-*`/`-write-*`-Permissions in der
> Capability. Der `fs:scope`-Block: breite `$HOME/mads-worktrees/**`-Allow, **nicht** durch das Glob
> allein gegated, sondern durch (a) `deny`-Vorrang für `.git`/`.env`/`.env.*`/`.ssh`/`.aws`/
> `node_modules`/`target`, (b) `requireLiteralLeadingDot: true` in `tauri.conf.json`
> (`{ "plugins": { "fs": { "requireLiteralLeadingDot": true } } }`) und vor allem (c) den
> **Runtime-Prefix-Check im Core** (`ensure_in_scope`: canonicalize + Präfix-Assertion auf `repoRoot`
> + `~/mads-worktrees/<slug>/<agentId>`, §5). Das Glob ist der grobe, der Core-Check der eigentliche Gate.

### 4.3 Rust-Core — bleibt dünn

**MVP — für die Rail: null Core-Änderungen.** Der Core (`src-tauri/src/lib.rs`) registriert heute nur
`tauri_plugin_opener` + `tauri_plugin_dialog` und die Handler `start_sidecar`/`sidecar_send`/
`stop_sidecar`; er parst NDJSON nicht (CLAUDE.md §„Schichten"). Im MVP bleibt das so: die
Shortcuts (`⌘1..n`/`⌘,`/`⌃⌘B`) laufen rein im Frontend (§8), kein `lib.rs`-Edit.

**Rail-getriebene Core-Arbeit (Post-MVP, explizit als Core-Touchpoint geführt):**

- **Natives „Ansicht"-Menü (Owner: dieses Doc).** Wenn die Panel-Shortcuts zusätzlich als native
  Menüeinträge erscheinen sollen, ist `build_app_menu` in `lib.rs` zu erweitern: ein „Ansicht"-Submenu
  mit Per-Item-Accelerators (⌘1/⌘2/⌘,/⌃⌘B für die View-/Kollaps-Umschalter, plus ⇧⌘D für den
  Änderungen-Overlay-Toggle) plus `on_menu_event`-Plumbing und ein `emit` je Eintrag, das das
  Frontend auf `setActiveView`/`toggleRailCollapsed`/`toggleChangeOverview` mappt. Das ist eine echte
  `lib.rs`-Änderung (privilegierte Schicht) und daher **bewusst Post-MVP** — der MVP bleibt
  Frontend-only (§8). Solange dieses Menü nicht existiert, gilt „null Core-Änderungen" wörtlich.

Die von der Rail aktivierten Panels (Dateien/Changes) brauchen ebenfalls Core-Erweiterungen — aber
**dort** spezifiziert, nicht hier. Zur Erinnerung, damit die vier Docs konsistent bleiben (Owner:
[[07-file-explorer]]): `.plugin(tauri_plugin_fs::init())` in `lib.rs`, plus optional mads-eigene
`#[tauri::command]`s (`mads_read_dir`/`mads_read_file`/`mads_write_file`) mit Runtime-Scope-Check
und `app.fs_scope().allow_directory(&repoRoot, true)` nach `openProject` (für das arbiträr gewählte
Haupt-Checkout, dessen Pfad zur Build-Zeit unbekannt ist). Der Core bleibt damit **alleiniger
Owner** des FS-Zugriffs — wie er heute alleiniger Owner der Child-Prozesse ist.

---

## 5. Sicherheit & Schicht-Grenzen

> **Wichtige Grenze (CLAUDE.md §„Schichten"):** „`src/` — React/TS-Frontend. Reines UI: rendert
> State, sendet User-Intent. **Keine** Prozesse, **keine** Secrets, **keine** git/gh-Ausführung."
> Die Rail ist die buchstäbliche Verkörperung dieser Regel: sie rendert `activeView`/Badges und
> sendet `setActiveView`/Callbacks — sonst nichts.

- **Kein direkter FS-Zugriff im WebView.** Die Rail aktiviert Panels, die FS brauchen, aber **alle**
  Datei-Reads/Writes laufen **durch den Rust-Core** (tauri-plugin-fs mit gescopten Capabilities bzw.
  mads-`#[tauri::command]`). Die Rail selbst öffnet, liest, schreibt nichts. (Invariante: Frontend
  „Darf NICHT" — git/gh/Prozesse/Secrets/Disk; [[01-architecture]] §2.2.)
- **Capability-Scoping:** Der FS-Zugriff der Ziel-Panels ist auf `repoRoot` + `~/mads-worktrees/**`
  begrenzt; `deny` (`.git`, `.env`, `.env.*`, `.ssh`, `.aws`, `node_modules`, `target`) hat
  **Vorrang** vor `allow` (runtime-enforced) und `requireLiteralLeadingDot: true` verhindert, dass
  ein `**`-Glob still in Dotfolder/Secrets greift. Secrets bleiben für Explorer/Editor unlesbar.
  Pfad-Traversal (`..`) ist plugin-seitig blockiert; der zusätzliche Runtime-Prefix-Check im Core
  (canonicalize + Präfix-Assertion) deckt Symlink-Escapes ab. (Detail: [[07-file-explorer]] §5.)
- **Sanitization untrusted/agent-authored content:** Die Rail rendert **keinen** Agenten-Output —
  Labels/Icons/Tooltips stammen ausschließlich aus der **statischen, code-eigenen** `TOOLBAR_ITEMS`-
  Registry, nicht aus Sidecar-/Agenten-Daten. **Badge-Werte sind reine Zahlen** (`escalations.length`,
  `collisions.length`) bzw. `"dot"`, nie Freitext → keine Injection-Fläche. (Markdown/Diff-
  Sanitization untrusted Inhalts gehört in die Panels: [[09-change-overview]] rendert
  agent-authored Diffs, [[07-file-explorer]] Markdown — beide mit `rehype-sanitize`.)
- **Link-Safety:** Die Rail enthält **keine** externen Links. Externe URLs (PR-Links etc.) öffnen
  weiterhin ausschließlich über `@tauri-apps/plugin-opener` `openUrl()` in den Panels (wie heute
  Inspector/About), nicht über `<a href>` im WebView.
- **Keine außen-sichtbare Aktion in der Rail (Invariante 4).** push/pr/merge sind ausschließlich
  explizite Panel-Aktionen (Integrator-Panel, [[02-dashboard]] §7). Die Rail kann sie nicht
  auslösen — sie wechselt nur die Ansicht. Insbesondere existiert **kein** Merge-Button in der Rail
  (Invariante 1).
- **State-Persistenz (Invariante 5).** Rail-Präferenzen liegen im WebView-localStorage, **außerhalb**
  der drei autoritativen State-Stores (Sidecar-Pool/`agents.json`/SQLite). Der Core spiegelt sie
  nicht; es gibt keinen zweiten Writer auf Agenten-State.

---

## 6. Performance & Skalierung

- **Rendering-Kosten ~0:** Die Rail ist eine kurze, statische Liste (`TOOLBAR_ITEMS`,
  Größenordnung 5–10 Einträge). **Keine Virtualisierung nötig.** Badges sind memoisierbare Selektoren
  (`useStore((s) => s.escalations.length)`) — re-rendert nur bei Zähler-Änderung, nicht bei jedem
  `agent_event`-Tick.
- **Lazy-Mount der Panels:** Nur das Panel des aktiven `activeView` ist gemountet (`PrimaryPanel`-
  Switch). Das schwere Dateien-Panel ([[07-file-explorer]], `react-arborist` + ggf. CodeMirror) wird
  via `React.lazy`/`Suspense` **erst beim ersten Aktivieren** geladen — der Bundle-Pfad für den
  Default-Streams-View bleibt schlank. Der Content (AgentGrid/Inspector) bleibt unverändert
  permanent gemountet.
- **Coalescing:** Nicht erforderlich — die Escalations/Collisions-Zähler ändern sich nur im
  Sidecar-Poll-Takt ([[02-dashboard]] §8) und liegen im Store als fertige Werte; die Rail liest sie
  über memoisierte Selektoren, ohne eigene Drosselung.
- **Caps & Surfacing (nie still abschneiden):** Falls `TOOLBAR_ITEMS` durch Plugins künftig wächst
  und die Rail-Höhe überschreitet, wird die `group: "top"`-Liste **scrollbar** (overflow-y), die
  `group: "bottom"`-Liste bleibt unten angedockt — es wird **nichts** still verworfen. Badge-Zahlen
  > 99 werden als `99+` dargestellt (gekappte **Anzeige**, nicht gekappter Wert); der wahre Wert
  bleibt im Tooltip/`aria-label`. Ein im Frontend gesetztes Anzeige-Cap wird im Tooltip sichtbar
  gemacht — kein stilles Truncating.

---

## 7. Edge-Cases & Fehlerzustände

| Fall | Verhalten |
|---|---|
| **Kein Projekt offen** (`project == null`) | „Dateien"/„Änderungen" sind `disabled` (`enabled: (s) => !!s.project`), grau, mit Tooltip „Erst ein Projekt öffnen". Klick ist no-op. Aktiver `activeView` fällt auf `streams` zurück, falls er ungültig würde. |
| **Persistierter `activeView` zeigt auf gesperrtes/entferntes Panel** | Beim Init validiert der Store gegen `TOOLBAR_ITEMS` + `enabled`; ungültig → Fallback `"streams"`. Kein Crash, kein leeres Panel. |
| **Projektwechsel während Datei-View aktiv (bzw. Changes-Overlay offen)** | Panel/Overlay re-anchort auf neuen `project.repoRoot` (Panel-eigene Logik); die Rail bleibt unverändert. |
| **localStorage nicht verfügbar/defekt** | `loadUiPrefs()` fällt auf Defaults zurück (`activeView: "streams"`, `railCollapsed: false`) — exakt das Fail-soft-Muster von `src/recent.ts` (`try { … } catch { return [] }`). |
| **Sidecar down** | Rail bleibt voll bedienbar (reines UI). Panels zeigen ihren eigenen Down-State; die Rail spiegelt das nicht. |
| **Schmales Fenster** (`minWidth: 900`, `tauri.conf.json`) | Rail erzwingt bei Unterschreitung eines Breakpoints automatisch `railCollapsed` (nur-Icon), gibt aber Platz nicht durch Verstecken auf — analog Sidebar-Kollaps [[02-dashboard]] §2. Manuelle Präferenz bleibt gespeichert und wird beim Verbreitern wiederhergestellt. |
| **Reduced transparency** | Vibrancy → solider Hintergrund (CSS + Material-Deaktivierung), siehe §8. |

---

## 8. Barrierefreiheit & Tastatur

- **Rolle/Semantik:** Die Rail ist `<nav aria-label="Hauptnavigation">`; die Einträge sind
  `<button>` (kein Div-onClick). Der aktive Eintrag trägt `aria-current="true"`. **Bewusste Wahl
  `aria-current="true"` (nicht `"page"`):** mads ist eine Ein-Fenster-App ohne Router (FRONTEND MAP:
  „No router — single screen"); die Rail wechselt In-App-Panels, keine navigierten Seiten/URLs, daher
  ist `"true"` der semantisch genauere Token für einen Panel-Selektor. **Bewusste Wahl `<nav>` +
  `<button>` (nicht `role="tablist"`/`tab`/`tabpanel`):** die Einträge umfassen nicht nur
  gegenseitig-exklusive Panel-Umschalter, sondern auch reine **Aktionen** (Neuer Stream, Über mads)
  und ein **Popover** (Projekt, §2.3) — gemischte Semantik, für die ein striktes Tablist-Muster (jeder
  Tab steuert genau ein `tabpanel`) nicht passt; das `<nav>`+button-Muster trägt alle drei
  `kind`-Varianten einheitlich.
- **`aria-label` pro Eintrag:** immer gesetzt — **besonders im kollabierten Zustand**, wo nur das
  Icon sichtbar ist (z.B. `aria-label="Streams (2 Eskalationen)"`). Badges werden in das `aria-label`
  eingebettet, damit VoiceOver sie ansagt.
- **Tooltips:** im kollabierten Zustand nativer Tooltip via `title` (Hover) **und** zugängliches
  Label (`aria-label`) — Tooltip allein genügt der A11y nicht.
- **Fokus-Ring:** `:focus-visible` mit `--accent`-Outline (HIG, sichtbarer Tastatur-Fokus).
- **Fokus-Reihenfolge:** Rail → Primary-Panel → Content (Titlebar → AgentGrid → Inspector),
  konsistent mit der Tab-Order aus [[02-dashboard]] §11.
- **Shortcuts (HIG-konform, [[macos-design]] A.9; ergänzen die [[02-dashboard]]-§9.2-Tabelle):**

| Shortcut | Bedeutung |
|---|---|
| **⌘1** | View „Streams" — Content (AgentGrid + Inspector), **kein** Mittel-Panel (Rücksprung-Anker, §1a.6) |
| **⌘2** | Panel „Dateien" ([[07-file-explorer]]) |
| **⇧⌘D** | „Änderungen" an/aus — Overlay-Toggle (`changeOverviewOn`), **kein** Panel ([[09-change-overview]] §8) |
| **⌘…n** | weitere Panels in Registry-Reihenfolge (`shortcut`-Feld) |
| **⌘,** | Panel „Einstellungen" (HIG-Standard für Preferences) |
| **⌃⌘B** | Rail ein-/ausklappen (Kollaps-Toggle) |

> **Shortcut-Konsistenz mit [[09-change-overview]] §8:** Der „Änderungen"-Toggle nutzt **⇧⌘D** (dort
> als Change-Overview-Toggle definiert), **nicht** ⌘3 — weil es kein nummeriertes Panel ist. ⌘3 bleibt
> frei für ein künftiges echtes Panel.

> **MVP — rein im Frontend:** `⌘1..n`, `⌘,` und `⌃⌘B` werden im Frontend via globalem
> `keydown`-Listener (in `App.tsx`, vgl. der vorhandene `listen("show-about")`-Listener) auf
> `setActiveView`/`toggleRailCollapsed` gemappt. Damit braucht der MVP **keine** Core-Änderung
> (konsistent mit §0/§4.3: „null Core-Änderungen für die Rail").
>
> **Post-MVP — nativer Menü-Touchpoint (Core):** Sollen die Shortcuts zusätzlich als native
> Menüeinträge erscheinen, ist das ein **expliziter Core-Touchpoint** — die App-Menüleiste wird um
> ein „Ansicht"-Menü erweitert (`src-tauri/src/lib.rs` `build_app_menu`, heute nur
> mads/Bearbeiten/Fenster, ohne Submenu/Accelerators). Das ist eine echte, nicht-triviale
> `lib.rs`-Änderung (Per-Item-Accelerators ⌘1/⌘2/⌘,/⌃⌘B plus ⇧⌘D für den Änderungen-Toggle, dazu
> `on_menu_event`-Plumbing und ein `emit` je Eintrag, das das Frontend dann auf
> `setActiveView`/`toggleChangeOverview` mappt). Es ist daher **nicht** Teil
> des Rail-MVP, sondern in §4.3 als „rail-getriebene Core-Arbeit" Post-MVP aufgeführt.

- **Reduced motion:** Panel-Wechsel ohne Slide-Animation bzw. Crossfade bei
  `prefers-reduced-motion: reduce`.
- **Reduced transparency:** Rail-Vibrancy → solider `--panel`-Hintergrund (CSS + Laufzeit-Material),
  wie [[02-dashboard]] §11.
- **Farbe nie alleiniger Träger:** der aktive Eintrag ist nicht nur farblich, sondern via
  `aria-current="true"` + Akzent-Indikator (linker Balken) + ggf. fettes Label markiert.

---

## 9. Tests

Vitest-Stil wie im Projekt (`shared/*.test.ts`, z.B. `collision.test.ts`). Schwerpunkt auf reine
Logik + leichtgewichtiges Component-Testing (jsdom):

- **Registry/Logik (unit, pur):** Damit dieser „reine Logik"-Pfad **nicht** `lucide-react` laden muss,
  sind `ToolbarItem`s Typ-Importe (`MadsState`, `LucideIcon`) `import type` (§3.2); die Icon-Komponente
  wird nur als Wert-Referenz gehalten und in den Logik-Tests nicht ausgewertet (alternativ die
  Icon-Zuordnung in ein separates `src/toolbarIcons.ts` ziehen, sodass `toolbarItems.ts` selbst
  dep-frei bleibt) — id-Eindeutigkeit/`kind`/`view`/`order` sind so ohne Icon-Dep testbar.
  - `TOOLBAR_ITEMS` ist konsistent: eindeutige `id`s, jedes `kind:"panel"` hat ein `view`, jedes
    `view` ist ein gültiges `ViewId`, `order` ist eindeutig.
  - `enabled`-Prädikate: „Dateien"/„Änderungen" sind ohne `project` deaktiviert, mit `project`
    aktiviert.
  - `badge`-Selektoren: liefern `undefined` bei 0, die Zahl bei `escalations`/`collisions` > 0,
    `99+`-Anzeige-Cap bei > 99.
- **Store (unit):**
  - `setActiveView`/`toggleRailCollapsed`/`setRailCollapsed` setzen den State **und** schreiben
    `mads.uiPrefs` in localStorage (localStorage gemockt).
  - `loadUiPrefs()`: valider Wert wird gelesen; defekter/fehlender Wert → Defaults
    (`streams`/`false`); ungültiger persistierter `activeView` → Fallback `streams`.
- **Komponente (jsdom):**
  - `ActivityRail` rendert Labels nur bei `railCollapsed === false`; bei `true` nur Icons + `title`.
  - Klick auf einen `panel`-Eintrag ruft `setActiveView` mit der richtigen `view`.
  - `action`-Einträge rufen ihren Callback (`onNewStream`/`onAbout`), ändern `activeView` **nicht**.
  - `aria-current`/`aria-label` (inkl. Badge-Einbettung) korrekt gesetzt.
  - `PrimaryPanel` rendert für `streams` **`null`** (kein Mittel-Panel, §1a.5) und für `files`/
    `settings` die jeweilige Panel-Komponente (Smoke-Test je Branch des Switch).
  - der „Änderungen"-Eintrag ruft `toggleChangeOverview` (Aktion), ändert `activeView` **nicht** und
    ist `.active` an `changeOverviewOn` gebunden (nicht an `activeView`).
- **A11y (integration, leicht):** disabled-Einträge sind nicht fokussierbar/aktivierbar; Shortcut
  `⌘2` setzt `activeView` auf `files`.

---

## 10. Roadmap

Konsistent mit der P-Roadmap und **OE-3** („MVP = ein Hauptfenster"). Die Rail führt **kein**
zweites Fenster ein.

**MVP (Phase „Navigation"):**

1. `ActivityRail` + `ActivityRailItem` + `PrimaryPanel` + `TOOLBAR_ITEMS`-Registry.
2. **Auflösung `Sidebar.tsx`** (§2.1-Callout): Stream-Liste löschen (Grid ist die Liste),
   Recent/Projekt → `RecentProjectsPopover`, Brand/About/Neuer-Stream → Rail, Sidecar-Health →
   Statusleiste; „Erledigt · N" als kollabierte Grid-Sektion ([[02-dashboard]] §3).
3. Store: `activeView` + `railCollapsed` + Actions + `src/uiPrefs.ts` (localStorage).
4. Einträge im MVP: **Projekt** (Recent-Popover), **Neuer Stream** (Aktion), **Streams** (Default-View
   = Rail + Content, **kein** Mittel-Panel), **Einstellungen** (Platzhalter/Autonomy-Toggles),
   **Über mads** (Aktion).
6. Kollaps + Persistenz; `⌘1`/`⌘,`/`⌃⌘B`; Streams-Badge (`escalations.length`).
7. „Dateien"/„Änderungen" sind als Einträge **sichtbar, aber `disabled`/„demnächst"**, bis
   [[07-file-explorer]]/[[09-change-overview]] landen (klare Erweiterungs-Punkte, kein Toter-Link).

**Post-MVP (phasenweise, je Panel-Doc):**

- **Dateien-Panel** aktivieren (lazy-mounted), `⌘2`, Capability/Core (Owner [[07-file-explorer]]).
- **Changes-Overlay** aktivieren (Rail-Toggle „Änderungen" → `toggleChangeOverview`, `⇧⌘D`),
  Kollisions-Badge (Owner [[09-change-overview]]) — **Overlay, kein Panel**.
- **Updates-Eintrag** + `update_status`-Badge (Owner [[05-update-area]]).
- **Settings-Panel** ausbauen (Permission-Defaults, Modelle, Autonomie — aus Titlebar konsolidiert).
- Plugin-fähige Registry (Dritt-Einträge), falls je relevant.

---

## 11. Offene Entscheidungen

> **OFFENE FRAGE (Icon-Set, OE-49):** `lucide-react` (Empfehlung) vs. weiterhin eigene SVGs?

- **OE-49 Icon-Set für die Activity-Rail** *(offen; Default gesetzt)*. **Default: `lucide-react`**
  (tree-shaken, konsistentes 16–20 px-Set, React-19-kompatibel; der App-Stil rollt SVGs heute selbst,
  aber die Rail ist der natürliche Einführungsort, ohne Bestands-SVGs/`StatusDot` anzufassen). Offen
  bleibt, ob `StatusDot`/Brand mittelfristig mit-migrieren. (Doc 10 §2.1, [[02-dashboard]] §3.2)

- **OE-50 Default-View beim App-Start.** Immer `streams` (heutiges Verhalten, robust) — oder den
  **zuletzt aktiven** `activeView` aus `mads.uiPrefs` wiederherstellen (kontextbewahrend, aber kann
  auf ein leeres/gesperrtes Panel zeigen)? *(Vorschlag: persistierten View wiederherstellen, mit
  Fallback auf `streams`, wenn `enabled` false ist — §7.)* Da `streams` **kein** Mittel-Panel hat
  (§1a.5), ist `streams` zudem immer ein sicherer Fallback. (Doc 10 §3.1/§7)

- **OE-51 Auto-Kollaps-Breakpoint.** Soll die Rail bei schmalem Fenster **automatisch** in den
  Nur-Icon-Modus wechseln (und beim Verbreitern die manuelle Präferenz wiederherstellen), oder bleibt
  Kollaps **rein manuell**? Falls auto: welcher Breakpoint relativ zu `minWidth: 900`
  (`tauri.conf.json`) und zur Sidebar-Kollaps-Schwelle aus [[02-dashboard]] §2? *(Vorschlag: auto-
  kollabieren unter dem 900–1200-Breakpoint, manuelle Präferenz separat persistiert.)* (Doc 10 §7)

- **OE-52 Auflösung der persistenten Sidebar + Verbleib ihrer Elemente** *(ENTSCHIEDEN durch den
  Design-Review, §1a; früher: „Verhältnis Rail-Einträge ↔ Titlebar-Controls").* **Entscheidung:**
  Die persistente Stream-Sidebar (`Sidebar.tsx`) wird **aufgelöst** — ihre Stream-Liste ist redundant
  mit dem `AgentGrid` (§1a.1) und widerspricht dem Activity-Bar→Side-Bar→Editor-/Xcode-Navigator-/
  HIG-Sidebar-Muster (§1a.2). Der Default-Streams-View ist **Rail + Content (AgentGrid + Inspector)**,
  **ohne** Mittel-Panel; das Primary-Panel ist rein aktivitäts-spezifisch (Dateien/Settings;
  „Änderungen" ist ein Overlay, kein Panel — §2.3, §1a.4/§1a.5). Verbleib der Unikat-Elemente
  (§1a.3): Recent/Projekt → `RecentProjectsPopover`
  (Rail-Eintrag „Projekt"); Brand/About/Neuer-Stream → Rail; „Erledigt"-Gruppe → kollabierte
  Grid-Sektion; Sidecar-Health → Statusleiste. Off-Dashboard-Awareness über Rail-Badge + Notification
  + `⌘1`-Rücksprung (§1a.6). **Noch offener Unter-Punkt (Titlebar-Controls):** „+ Neuer Stream" in
  Rail **und** Titlebar (Schnellzugriff, dieselbe Action); Auto-Sync-/Kollisions-Scan-Toggles ins
  Settings-Panel; Version-/Repo-/Sidecar-Pills und `↻` bleiben in der `.titlebar` (`App.tsx`) — kein
  Doppel-SSOT, nur Spiegelung derselben Actions. Diese Toggle-/Pill-Zuordnung ist die einzige noch
  offene Feinheit; die Sidebar-Auflösung selbst ist entschieden. (Doc 10 §1a/§2.1/§2.3,
  [[02-dashboard]] §2/§9; README-OE-Liste entsprechend reconcilen.)

---

## LAYOUT-CONTRACT (SSOT für 02/07/09)

> Dies ist die **normative Kurzfassung** der Layout-Entscheidung dieses Docs, auf die
> [[02-dashboard]], [[07-file-explorer]] und [[09-change-overview]] sich per Punkt-Buchstabe
> berufen. Ändert sich hier etwas, ziehen die drei nach (single source of truth — die Details
> stehen in §1a/§2.2, hier nur die verbindlichen Klauseln).

Die `.app`-Reihe ist **`Activity-Rail | Primary-Panel | .main`** — **keine** persistente Sidebar.

- **(a) `.main` bleibt unverändert.** In **jeder** View bleibt `.main` (Titlebar + `.body` mit
  `.center`/`AgentGrid` **und** `<Inspector/>`) stehen und sichtbar. Kein View ersetzt oder
  verdrängt `.center`+`<Inspector/>`. (Doc 02 §2; [[07-file-explorer]] §1.3/§2.1)
- **(b) Streams-Default = kein Mittel-Panel.** `activeView === "streams"` (Default) rendert
  **kein** Primary-Panel; der Content steht direkt neben der Rail. Das `AgentGrid` **ist** die
  Stream-Liste — es gibt keine zweite (§1a.1).
- **(c) Panels bringen ihren eigenen Stream-Kontext mit.** Weil es keine persistente Stream-Liste
  mehr gibt, an der ein Panel passiv ablesen könnte, führt ein Panel, das eine Stream-Auswahl
  braucht, seinen **eigenen** Selektor — gespeist aus `order.map(id => agents[id])`, gebunden an
  `selectedId`/`selectAgent`, eingefärbt über `StatusDot`/`STATUS_META`. (Owner-Beispiel:
  [[07-file-explorer]] §1.2/§1.3 `StreamContextSwitcher`; [[09-change-overview]] nutzt dieselbe
  Identität für den Pane-Key `${agentId}::${path}`.)
- **(d) Primary-Panel ist aktivitäts-spezifisch, nie ein Content-Klon.** Es erscheint nur bei
  `activeView ∈ {files, settings, …}` und speist/ergänzt den Content, statt ihn zu duplizieren
  (§1a.2/§1a.4).
- **(e) Off-Dashboard-Awareness statt Spiegelung.** Mit aufgelöster Sidebar liefert das
  **Rail-Badge auf „Streams"** (+ Notification + `⌘1`-Rücksprung) die situative Awareness; keine
  permanent gespiegelte Stream-Liste (§1a.6).
- **(f) Mount-Regel.** `App.tsx` rendert **drei** Geschwister `<ActivityRail/>`,
  `<PrimaryPanel/>`, `<div className="main">`. `PrimaryPanel` ist der `activeView`-Switch: bei
  `"files"` → `<FileExplorer/>` als **eigene Mittel-Spalte**, bei `"settings"` → `<SettingsPanel/>`,
  bei `"streams"` → `null`. Der Wechsel ist ein **reiner Render-Switch über denselben Store** (kein
  State-Verlust). (§2.2; [[07-file-explorer]] §2.1)
- **(g) „Änderungen" ist kein Panel.** Die Change-Overview ist ein `position:fixed`-`<ChangeOverlay/>`
  über `.app` (letztes Kind), gesteuert vom `changeOverviewOn`-Toggle — **nicht** `activeView`,
  **keine** Mittel-Spalte; sie koexistiert mit jeder View (OE-41; [[09-change-overview]] §1.4/§2.1).

---

## 12. Querverweise

- [[07-file-explorer]] — Dateien-Panel (FS via tauri-plugin-fs/Core), das `activeView === "files"`
  aktiviert; Owner der Capability-/Core-FS-Anbindung.
- [[09-change-overview]] — Änderungs-**Overlay** (Rail-Toggle „Änderungen" → `changeOverviewOn`, **kein** `activeView`-Panel); Quelle des Kollisions-Badges.
- [[02-dashboard]] — Gesamtanordnung (Rail + Content + Inspector; **keine** persistente Sidebar
  mehr, §1a), Shortcut-Tabelle, A11y, Event-Topologie; die Rail ersetzt die alte Sidebar.
- [[05-update-area]] — optionaler Updates-Eintrag + Badge; Update-DB im Core (OE-27).
- [[01-architecture]] — Schicht-Grenzen, Capability-/Core-Modell, Event-Topologie (OE-5).
- [[macos-design]] — Sidebar-Material/Vibrancy, Traffic-Light-Abstand, Fokus-Ring, Shortcuts.
- [[06-ownership-and-coordination]] — Ownership/Kollisions-Modell, dessen Befunde die Changes-/
  Streams-Badges speisen.

---

## Offene Fragen (für den Review gesammelt)

1. **Icon-Set** (§2.1, OE-49): `lucide-react` (Empfehlung) vs. eigene SVGs — und ob `StatusDot`/Brand
   mitwandern.
2. **Default-View beim Start** (§3.1, OE-50): immer `streams` vs. persistierten `activeView`
   wiederherstellen (Fallback `streams`).
3. **Auto-Kollaps-Breakpoint** (§7, OE-51): automatisch bei schmalem Fenster vs. rein manuell;
   konkreter Breakpoint relativ zu `minWidth: 900`.
4. **Auflösung der Sidebar** (§1a, OE-52): **entschieden** — persistente Sidebar fällt weg, Streams-View
   ist Rail + Content ohne Mittel-Panel. Verbleibende Feinheit: Zuordnung der heutigen Titlebar-Controls
   (Neuer-Stream/Autonomie-Toggles/Pills/`↻`) zu Rail/Settings-Panel/Titlebar.
