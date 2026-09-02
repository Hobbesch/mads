# 11 — Härtung: Lehren aus dem Parallel-Betrieb (Juli 2026)

> **Status:** Post-Mortem + Härtungs-Design, beschlossen. Stand: 2026-07-17.
> **Sprache:** Deutsch (Fließtext), Englisch (Code/Identifier).
> **Anlass:** Ein realer Betriebstag im Juli 2026, an dem mads mehrere Sub-Agenten parallel
> auf einem **externen Kundenrepo** orchestriert hat. Zehn Vorfälle (§1) werden als
> Fallsammlung dokumentiert, auf **sieben Fehlerklassen** abstrahiert (§2), gegen den
> **nativen Fähigkeitsstand von Claude Code** gestellt (§3) und in eine **priorisierte
> Härtungs-Roadmap** überführt (§4).
> **Quellen:** [[_paix-multi-agent-reference]] (Invarianten), [[claude-code-capabilities]]
> plus offizielle Doku (code.claude.com/docs, verifiziert Juli 2026), Ist-Stand
> `sidecar/src/orchestrator.ts` / `sidecar/src/git.ts` / `sidecar/src/session.ts` und
> `shared/protocol.ts` (§„Prompt-Verwaltung").
> **README-Integration:** Index-Zeile, Glossar- und OE-Einträge sind **noch nicht** in
> [README](./README.md) nachgezogen (bewusst separater Edit, Shared-File-Protokoll). Die
> hier vergebenen Nummern **OE-53..OE-57 sind provisorisch bis zur README-Konsolidierung**
> (merge-time numbering — dieselbe Kollisionsvermeidung, die §2/F4 für Konventionen fordert).

---

## 0. Zusammenfassung & Einordnung

mads' Design-Docs 01–10 beschreiben, *wie* das System gebaut ist. Dieses Doc beschreibt,
**wo es im realen Parallel-Betrieb gebrochen ist** — und was daraus normativ folgt. Der
Befund in einem Satz: **Kein einziger Vorfall war ein LLM-Qualitätsproblem.** Alle zehn
waren *System*-Fehler der Orchestrierung — abgeleiteter Zustand, der log; Ereignisse, die
zum falschen Zeitpunkt gestempelt wurden; Konventionen, auf die nichts zeigte; Prüfungen,
die nie hätten scheitern können. Das ist eine gute Nachricht (die Agenten arbeiten), und
eine Verpflichtung: die Härtung liegt vollständig in mads' eigener Verantwortung, nicht
beim Modell.

Der zweite Befund (§3): Claude Code hat nativ inzwischen einen großen Teil der
**Mechanik** übernommen, die mads einmal exklusiv geboten hat (Worktree je Session,
Session-Übersicht, Worktree-Seeding). Der bleibende Kern von mads ist **Governance** —
Integrator-only-Merge, Gates *vor* dem PR, Ownership-/Kollisions-Scan, Deploy-Disziplin,
kuratierte Prompts. Genau die Schicht, in der die zehn Vorfälle passiert sind.

**Bezug zu den paix-Invarianten:** Vorfall V6 ist eine direkte Verletzung von
Invariante 3 („ein Worktree, ein Agent") — sie war dokumentiert, aber nicht **durchgesetzt**.
Das Muster „Invariante als Disziplin statt als Mechanik" ist die gemeinsame Wurzel mehrerer
Fälle und der Leitgedanke der Roadmap (§4): jede Invariante bekommt einen mechanischen
Wächter.

---

## 1. Fallsammlung: die zehn Vorfälle (V1–V10)

Jeder Fall: **Symptom → Ursache → Status → Lehre** (mit Fehlerklasse F1–F7 aus §2).
Alle Fälle stammen aus demselben Betriebstag; das Kundenrepo bleibt hier bewusst anonym
(mads ist projekt-agnostisch).

### V1 — Geist-Eskalation „Kein PR möglich"

- **Symptom:** Auf einem **bereits gemergten** Stream bot das UI „PR erstellen" an; der
  Klick produzierte eine rote Eskalation „Kein PR möglich".
- **Ursache (zweistufig):**
  1. Der Aufräum-Pfad nach dem Merge emittierte **kein** `git_status`-Event — für ~25 s
     zeigte der Stream einen **stale** Zustand mit `ahead > 0`, also bot das UI die
     PR-Aktion an, als gäbe es noch etwas zu mergen.
  2. Der Klick lief in ein **fail-open** `gitStatus()` (`sidecar/src/git.ts`): ein
     git-Fehler war im Rückgabewert **ununterscheidbar** von „keine Commits" — statt
     „Zustand unbekannt" meldete die Kette „nichts zu tun" bzw. eskalierte falsch-rot.
- **Status:** ✅ gefixt (P0, „Geist-Trio", §4.1): Aufräum-Pfad emittiert `git_status`;
  `gitStatus()` ist fail-closed (Fehler ≠ leeres Ergebnis); die PR-Aktion wird auf
  gemergten Streams nicht mehr angeboten.
- **Lehre:** Abgeleiteter Zustand braucht ein Ereignis an **jedem** Pfad, der ihn ändert —
  auch am Aufräum-Pfad. Und eine Ableitung, die Fehler als „leer" kodiert, ist fail-open
  (→ **F1**, **F2**, **F7**).

### V2 — Datenverlust durch bedingungsloses `git reset --hard`

- **Symptom:** Im `keepBranch`-Merge-Pfad (`orchestrator.ts` → `doIntegrate`) ging
  uncommittete Arbeit verloren.
- **Ursache:** Ein `git reset --hard` lief **bedingungslos** — ohne vorher zu beweisen,
  dass der Working-Tree nichts Ungesichertes enthält.
- **Status:** ✅ gefixt (Reset-Guard: destruktive Operation nur nach beweisbar sauberem
  Zustand, sonst Abbruch + Eskalation).
- **Lehre:** Jede destruktive git-Operation braucht einen Guard, der die Vorbedingung
  **beweist** statt annimmt — verweigern ist billiger als wiederherstellen (→ **F1**).

### V3 — „Mergen & weiterarbeiten" nur im RAM

- **Symptom:** Streams, die per „Mergen & weiterarbeiten" bewusst weiterliefen,
  **verschwanden nach App-Neustart**.
- **Ursache:** Die Absicht lebte nur in der In-Memory-Map `suppressedMergedPr`
  (`orchestrator.ts`) — der Resume-Pfad (agents.json) wusste nichts davon und
  archivierte die Streams als „gemergt = fertig".
- **Status:** ✅ gefixt (Absicht wird persistiert und beim Resume respektiert).
- **Lehre:** Wenn ein Neustart die **Semantik** ändert, ist der State falsch gelagert.
  Nutzer-Absichten sind Resume-Wahrheit (`agents.json`, OE-2), nie nur Pool-RAM (→ **F2**).

### V4 — mads-eigene Dateien machten Kunden-Worktrees dirty

- **Symptom:** Worktrees auf dem Kundenrepo waren „dirty", ohne dass der Agent etwas
  geändert hatte; Gates und Sync-Läufe stolperten über Fremdmaterial.
- **Ursache:** mads' eigene Laufzeitdateien (`.mads/attachments`) lagen im Working-Tree
  des Kunden und waren dort nicht ignoriert — der Orchestrator hat seinen eigenen
  Beobachtungsgegenstand kontaminiert.
- **Status:** ✅ gefixt (mads-eigene Pfade werden aus Status/Commit-Sicht kategorisch
  ausgenommen).
- **Lehre:** Der Orchestrator ist im Kunden-Worktree **Gast**: alles, was mads dort
  ablegt, muss für git unsichtbar sein — sonst ist mads selbst der „fremde Akteur" aus
  V6 (→ **F5**; Retention/Pruning der Attachments: P2, §4.3).

### V5 — Konventions-Drift zwischen parallelen Streams

- **Symptom:** Eine dokumentierte, **verbindliche** UI-Konvention des Kundenprojekts
  (Card-Tabs) wurde von einem neu gestarteten Stream nicht übernommen — er baute
  dieselbe Oberfläche anders.
- **Ursache:** Das Konzeptdokument mit der Regel wurde **nie gelesen, weil nichts darauf
  zeigte**: die CLAUDE.md des Kunden enthielt keinen Verweis, und die Regel selbst war
  als **Statusbericht** formuliert („X wurde als Tab umgesetzt") statt als Anweisung
  („Neue Detail-Ansichten SIND als Card-Tab zu bauen — siehe <Doc>"). Ein Agent, der den
  Kontext frisch aufbaut, hat keinen Anlass, ein unverlinktes Dokument zu suchen.
- **Status:** ✅ beim Kunden gefixt (Regel in CLAUDE.md gehoben + als Auslöser-Satz
  formuliert); der **mechanische Gate-Check** dafür ist geplant.
- **Lehre:** Eine Konvention existiert nur, wenn (a) am Trigger-Punkt ein **Zeiger**
  auf sie steht, (b) sie als **Regel** formuliert ist, nicht als Bericht, und (c) ein
  **Check** sie prüft. Dokument ohne Zeiger = totes Wissen (→ **F4**; mads-seitige
  Konsequenz: Konventions-Injektion in Sub-Agent-Prompts, P1, §4.2).

### V6 — Fremd-Edit-Vermischung im laufenden Worktree

- **Symptom:** Ein Checkpoint-Commit des Autopilots enthielt Änderungen, die **nicht vom
  Agenten stammten**; das Entwirren (welche Hunks gehören wem?) war Handarbeit.
- **Ursache:** Ein **externer Akteur** (ein weiterer Assistent) editierte im Worktree
  eines **laufenden** Streams. Der Autopilot committet mit `git add -A`
  (`autoCommit()`, `sidecar/src/git.ts`) — er nahm die Fremd-Edits kommentarlos in
  seinen Checkpoint auf. Die Invariante „ein Worktree, ein Agent" (paix, Invariante 3)
  war **dokumentiert, aber nirgends durchgesetzt**: kein Lock, keine Erkennung.
- **Status:** ❌ offen → **P1** (Fremd-Edit-Schutz + `git worktree lock`, §4.2, OE-53/OE-54).
- **Lehre:** `git add -A` ist nur korrekt unter der Annahme „alles hier stammt von mir".
  Diese Annahme muss **geprüft** werden (Worktree-Signatur seit dem letzten Agent-Turn),
  nicht geglaubt (→ **F5**).

### V7 — Deploy „abgeschlossen", während Docker noch baute

- **Symptom:** Die Eskalations-Karte meldete „Deploy abgeschlossen", während der Build
  auf dem Zielsystem noch lief. Zusätzlich war der hervorgehobene **Primärknopf falsch**:
  „Auslagern" statt „Als Release committen" — der eine sichere nächste Schritt war
  optisch die Nebenaktion.
- **Ursache:** Die Deploy-Erkennung stempelte beim **Befehls-START** — im
  `canUseTool`-Callback (`sidecar/src/session.ts`), also in dem Moment, in dem das SDK
  um **Erlaubnis** fragt, den Befehl auszuführen. Erlaubnis-Zeitpunkt ≠ Abschluss-Zeitpunkt.
- **Status:** ✅ teilgefixt (P0): Wording sagt jetzt ehrlich „Deploy **gestartet**", und
  der Primärknopf ist „Als Release committen". ❌ Das echte **Abschluss-Tracking**
  (Ende des Background-Tasks statt Start des Befehls) ist **P1** (§4.2, OE-56).
- **Lehre:** `canUseTool` ist ein *Vorher*-Hook. Wer dort „fertig" ableitet, verwechselt
  Ereignis-Start mit Ereignis-Ende — und ein falscher Primärknopf macht aus der
  Falschmeldung eine falsche Handlungsaufforderung (→ **F3**, **F7**).

### V8 — Version/Tag-Divergenz: `git describe` lieferte den alten Stand

- **Symptom:** Beim Kunden lag ein Release-Tag auf einem **verwaisten** Commit
  (nach Rebase/History-Umbau nicht mehr Ancestor von `main`). `git describe` lieferte
  darum einen **alten** Versionsstand — Deploy-Skripte ohne explizites Versions-Argument
  hätten **still** alt deployt.
- **Ursache:** Die Versionsquelle war eine **Konvention ohne Wächter**: „das Tag stimmt
  schon". Nichts prüfte Tag-Erreichbarkeit von `main`, nichts erzwang eine explizite
  Versionsangabe im Deploy-Aufruf.
- **Status:** ✅ mads-seitig entschärft (P0) über die neue **Prompt-Verwaltung**:
  kuratierte Deploy-Prompts mit **Pflicht-Platzhalter `{{version}}`** — die UI fragt den
  Wert beim Einfügen ab, ein Deploy ohne explizite Version ist über diesen Weg nicht
  mehr formulierbar (`SavedPrompt` in `shared/protocol.ts`). ❌ Die projektseitige
  Absicherung der Versionsquelle (version-Datei statt `git describe`, als
  Prompt-/Projekt-Konvention) ist **P2** (§4.3).
- **Lehre:** Eine implizite Versionsquelle ist ein stiller Default — und stille Defaults
  sind fail-open. Pflicht-Parameter machen das Weglassen **unmöglich** statt unwahrscheinlich
  (→ **F1**, **F4**).

### V9 — Passiver Integrator nach Neustart: Kernaktion unsichtbar

- **Symptom:** Nach App-Neustart zeigte der (passive, gerade nicht laufende) Integrator
  keinen dirty-Zustand — die zentrale Aktion darauf blieb unsichtbar, obwohl der
  `main`-Checkout Änderungen enthielt.
- **Ursache:** Der Resume-Pfad **pollte den passiven Integrator nie**: `git_status` wurde
  nur für aktive Sessions erhoben. „Kein Status" wurde im UI wie „sauber" gerendert —
  dieselbe fail-open-Signatur wie V1, eine Ebene höher.
- **Status:** ✅ gefixt (P0): der Integrator wird nach Resume initial gepollt wie jeder
  aktive Stream.
- **Lehre:** „Unbekannt" ist ein eigener Zustand und muss als solcher durch die ganze
  Kette (Sidecar → Protokoll → UI) transportiert werden — nie als „leer/sauber"
  (→ **F1**, **F2**).

### V10 — Vakuöse Prüfungen: die Klasse „Check, der nie scheitern kann"

- **Symptom:** Drei unabhängige Prüfungen desselben Tags erwiesen sich als wertlos —
  nicht weil sie fehlten, sondern weil sie **nicht scheitern konnten** (oder an allem
  scheiterten, was informationstheoretisch dasselbe ist):
  1. **eslint ohne TS-Parser** im Kundenrepo: schlug an **jeder** Datei fehl — ein Gate,
     das immer rot ist, unterscheidet nichts und wird ignoriert oder wegkonfiguriert.
  2. **grep gegen einen leeren Hash:** die Variable war leer, das Muster matchte trivial —
     der Check war immer grün.
  3. **BSD-`find` mit stillem Parameter-Fehler:** die GNU-Syntax wurde auf macOS still
     anders interpretiert — der Check prüfte etwas anderes als gedacht, ohne Fehlermeldung.
- **Ursache:** Alle drei teilen die Wurzel: die Prüfung wurde eingerichtet, aber nie
  **gegen einen bekannten Fehlerfall** getestet. Ein Check ohne Gegenprobe ist eine
  Vermutung mit grünem Icon.
- **Status:** ❌ systematisch offen → **P1** (explizite Gate-Konfiguration je Projekt,
  `.mads/gate.json`, statt Auto-Detect; §4.2, OE-55). Punktuell an dem Tag behoben.
- **Lehre (normativ):** **Jede Prüfung braucht eine Gegenprobe, die beweist, dass sie
  scheitern KANN.** Beim Einrichten eines Gates gehört ein absichtlicher Fehlerfall
  dazu (Mutations-Probe: kaputte Datei rein → Gate muss rot werden → wieder raus).
  Portabilität (BSD vs. GNU) ist Teil der Gegenprobe (→ **F6**).

---

## 2. Fehlerklassen: die Abstraktion (F1–F7)

Die zehn Vorfälle reduzieren sich auf sieben wiederkehrende Klassen. Die Tabelle ist
das eigentliche Ergebnis dieses Docs — neue Features sind gegen diese sieben Fragen zu
reviewen (siehe Checkliste am Ende der Sektion).

| # | Fehlerklasse | Vorfälle | Gegenmittel (normativ) |
|---|---|---|---|
| **F1** | **Fail-open statt fail-closed.** Ein Fehler-/Unbekannt-Zustand ist im Datenfluss ununterscheidbar von „alles ok / nichts zu tun". | V1, V2, V8, V9 | Jede Ableitung transportiert ihren Fehlerzustand **explizit** (ok / unknown / error — nie `null` = „sauber"). UI-Regel: `unknown` ⇒ Aktion **nicht** anbieten. Destruktive Operationen nur nach **bewiesener** Vorbedingung (Guard), sonst Abbruch + Eskalation. |
| **F2** | **Abgeleiteter Zustand nur im RAM** (bzw. nie re-hydriert). Neustart oder Race macht die Anzeige zur Lüge. | V1, V3, V9 | Lackmustest: „Ändert ein Neustart die Semantik?" ⇒ falsch gelagert. Nutzer-Absichten → `agents.json` (Resume-Wahrheit, OE-2). Abgeleiteter git-Zustand → nach **jedem** mutierenden Pfad (auch Aufräum-Pfaden!) neu emittieren; passive Akteure beim Resume initial pollen. |
| **F3** | **Ereignis-Start vs. -Ende verwechselt.** Ein *Vorher*-Hook (`canUseTool`) wird als Abschluss-Signal gelesen. | V7 | Status-Aussagen nur an **beweisbaren Abschluss** knüpfen (Exit-Code, Task-Ende) — nie an Erlaubnis-/Start-Zeitpunkte. Bis dahin ehrliches Wording („gestartet", nicht „abgeschlossen"). |
| **F4** | **Konvention ohne Durchsetzung.** Regel existiert als Dokument, aber nichts zeigt darauf, und nichts prüft sie. | V5, V8 | Dreiklang: **Zeiger** am Trigger-Punkt (CLAUDE.md-Verweis) + **Regel-Formulierung** (Anweisung, nicht Statusbericht) + **mechanischer Check** (Gate). mads-seitig: Konventions-Injektion in Sub-Agent-Prompts (P1). |
| **F5** | **Geteilte Working-Trees ohne Lock.** Invariante 3 („ein Worktree, ein Agent") ist Disziplin statt Mechanik; `git add -A` glaubt, statt zu prüfen. | V4, V6 | `git worktree lock` je laufendem Agenten (P1); **Fremd-Edit-Erkennung** vor jedem `autoCommit` (Worktree-Signatur seit letztem Agent-Turn, P1); mads-eigene Dateien für git unsichtbar halten (✅). |
| **F6** | **Vakuöse Verifikation.** Der Check kann nicht scheitern (immer grün), scheitert an allem (immer rot) oder prüft still das Falsche. | V10 | **Gegenprobe-Pflicht:** beim Einrichten jeder Prüfung ein bekannter Fehlerfall, der sie rot macht (Mutations-Probe). Werkzeug-Portabilität (BSD/GNU) explizit testen. Gates deklarativ statt auto-detektiert (`.mads/gate.json`, P1). |
| **F7** | **Falsche Default-Aktion im UI.** Die hervorgehobene Aktion passt nicht zum tatsächlichen Zustand — der sichere nächste Schritt ist die Nebenaktion, oder eine sinnlose Aktion wird angeboten. | V1, V7 | Der Primärknopf ist eine **Zustands-Aussage** („das ist jetzt der sichere nächste Schritt") und wird aus dem Zustand **hergeleitet**, nicht statisch gesetzt. Aktionen, deren Vorbedingung `unknown`/falsch ist, werden gar nicht angeboten (F1-Kopplung). |

**Review-Checkliste (für jedes neue Feature, das Zustand ableitet oder Aktionen anbietet):**

1. Was passiert bei einem **Fehler** in der Ableitung — ist er von „leer" unterscheidbar? (F1)
2. Überlebt die Semantik einen **App-Neustart**? Emittiert **jeder** mutierende Pfad das Update? (F2)
3. Stempelt das Feature bei **Start** oder bei **beweisbarem Ende**? (F3)
4. Welche Konvention setzt es voraus — und **was zeigt darauf, was prüft sie**? (F4)
5. Nimmt es an, dass der Working-Tree **nur ihm** gehört — und **prüft** es das? (F5)
6. Kann jeder neue Check **beweisbar scheitern** (Gegenprobe durchgeführt)? (F6)
7. Ist die **hervorgehobene** Aktion in jedem erreichbaren Zustand die richtige? (F7)

---

## 3. Strategie: Claude Code nativ vs. mads-Kern (Stand Juli 2026)

### 3.1 Was Claude Code nativ inzwischen kann (verifiziert, code.claude.com/docs)

Gegen die offizielle Doku verifiziert (Juli 2026; Versions-Tracking dieser Fähigkeiten
ist Aufgabe des Update-Bereichs, [[05-update-area]]):

| Native Fähigkeit | mads-Gegenstück |
|---|---|
| Desktop-App erstellt **automatisch einen Worktree je Session** | Worktree-Management (`~/mads-worktrees/<slug>/<agentId>`, OE-1) |
| **Agent View** (`claude agents`) gruppiert Sessions nach *Needs input / Working / Done* | AgentGrid-Statusgruppen ([[02-dashboard]]) |
| Sidebar **archiviert Sessions automatisch bei PR-Merge** | „Erledigt"-Sektion im Grid |
| Subagent-Isolation via **`isolation: worktree`** | Session-Isolation im Sidecar-Pool ([[04-sub-agents]]) |
| **`.worktreeinclude`** — deklariert, welche unversionierten Dateien in neue Worktrees kommen | mads' Worktree-Seed (`.mads/worktree-seed`, Auto-Detect gitignorierter Dev-Configs) |
| **Repo-weit geteilte Permission-Approvals** | Permission-Defaults je Projekt ([[04-sub-agents]] §4.4, OE-20) |
| **`git worktree lock`, während ein Agent läuft** | fehlt in mads (→ **Adoption**, P1) |
| Optionales **Auto-Merge bei grünem CI** | bewusst **nicht** übernommen (s. u.) |

### 3.2 Konsequenz: Mechanik wird Commodity — Governance ist der Kern

Die linke Spalte war 2025 mads' Alleinstellung; sie ist es nicht mehr. **Worktrees,
Seeding und Session-Übersicht sind zunehmend Commodity** — wer nur das braucht, braucht
mads nicht. Der bleibende Kern von mads ist die Schicht **darüber**, die Claude Code
bewusst nicht besetzt (und die genau dort liegt, wo die zehn Vorfälle passiert sind):

- **Integrator-only-Merge** — genau ein Akteur landet auf `main` ([[03-main-agent]]).
  Das native **Auto-Merge bei grünem CI übernimmt mads ausdrücklich nicht**: grünes CI
  ist notwendig, nicht hinreichend (Vor-Merge-Gate, Review, OE-16 Default menschliches
  Approval) — Auto-Merge wäre die Rückabwicklung von Invariante 1.
- **Gate VOR dem PR** — deterministische Prüfkette beim Produzenten, nicht erst im CI
  (und nach V10: Gates mit Gegenprobe, deklarativ konfiguriert).
- **Ownership-/Kollisions-Scan** — Trespass *vor* dem Merge sichtbar
  ([[06-ownership-and-coordination]]).
- **Auto-Sync** — stale base als Dauerpflege statt Merge-Tag-Überraschung.
- **Deploy-Disziplin** — Erkennung, Abschluss-Tracking, richtiger Primärknopf (V7),
  Release-Stempel.
- **Kuratierte Prompt-Verwaltung** — betriebliche Rezepte als geprüfte, rollengebundene
  Artefakte mit Pflicht-Platzhaltern (V8) statt Freitext aus dem Gedächtnis.

**Positionierung in einem Satz:** Claude Code liefert die *Ausführung* paralleler
Sessions; mads liefert die *Ordnung* darüber — wer wann was auf `main` bringen darf,
und mit welchem Beweis.

### 3.3 Empfohlene Adoptionen aus Claude Code

Zwei native Muster übernimmt mads aktiv (beide P1, §4.2):

1. **`git worktree lock` während Agent-Läufen** — der Lock macht Invariante 3 mechanisch
   sichtbar (auch für Menschen und fremde Tools, die den Worktree öffnen wollen) und ist
   das direkte Gegenmittel zu V6/F5.
2. **Fremd-Edit-Erkennung vor Autopilot-Commits** — das Komplement zum Lock: selbst wenn
   jemand am Lock vorbei editiert, committet der Autopilot Fremdes nicht mehr blind.

---

## 4. Härtungs-Roadmap (priorisiert)

### 4.1 P0 — an diesem Betriebstag umgesetzt ✅

| Maßnahme | Vorfall | Inhalt |
|---|---|---|
| **Geist-Trio-Fixes** | V1 | (a) Aufräum-Pfad nach Merge emittiert `git_status` (kein 25-s-Stale-Fenster mehr); (b) `gitStatus()` fail-closed — git-Fehler ist von „keine Commits" unterscheidbar; (c) PR-Aktion wird auf gemergten Streams nicht mehr angeboten. |
| **Passiver Integrator-Poll** | V9 | Integrator wird nach App-Resume initial gepollt; dirty-Zustand und Kernaktion sind sofort sichtbar. |
| **Deploy-Wording + richtiger Primärknopf** | V7 | Eskalation sagt „Deploy **gestartet**" (ehrlich zum Erkennungszeitpunkt); Primärknopf ist „Als Release committen" statt „Auslagern". |
| **Prompt-Verwaltung** | V8 | Kuratierte, **rollengebundene** Prompts (`role: "integrator" \| "sub" \| "any"`) mit `{{name}}`-**Platzhaltern** (UI fragt Werte beim Einfügen ab — Pflicht-`{{version}}` für Deploys) und **Einfügen-statt-Senden** (Review im Composer, nie Auto-Send). Typen: `SavedPrompt`/`PromptSaveMsg`/`PromptDeleteMsg`/`PromptsUpdateMsg` in `shared/protocol.ts`; Persistenz `<repoRoot>/.mads/prompts.json`. |

Bereits **vor bzw. unabhängig von diesem Tag gelandet** (in §1 als „gefixt" markiert,
hier nur der Vollständigkeit halber): Reset-Guard im `keepBranch`-Merge (V2), Persistenz
der „Mergen & weiterarbeiten"-Absicht (V3), Ausnahme der mads-eigenen Dateien aus der
git-Sicht (V4).

### 4.2 P1 — als Nächstes (Governance-Härtung)

| Maßnahme | Vorfall/Klasse | Inhalt |
|---|---|---|
| **Fremd-Edit-Schutz** | V6 / F5 | Der Autopilot committet nur, wenn sich der Worktree seit dem letzten Agent-Turn **nicht durch Dritte** geändert hat (Signatur-Vergleich vor `autoCommit`); mindestens eine deutliche Warnung, Default fail-closed (OE-53). |
| **`git worktree lock` je laufendem Agenten** | V6 / F5 | Lock beim Session-Start, Unlock bei Stop/Done; macht Invariante 3 mechanisch (OE-54, Adoption aus Claude Code §3.3). |
| **Deploy-Abschluss-Tracking** | V7 / F3 | „Abgeschlossen" erst beim **Ende des Background-Tasks** (Exit-Code), nicht beim Befehls-Start in `canUseTool` (OE-56). |
| **Explizite Gate-Konfiguration je Projekt** | V10 / F6 | `.mads/gate.json` statt Auto-Detect: deklarierte Checks mit definierter Fehler-Semantik + **Gegenprobe beim Einrichten** (OE-55). |
| **Konventions-Injektion in Sub-Agent-Prompts** | V5 / F4 | Projekt-Konventionen (Zeiger + Regeln) werden neuen Streams aktiv in den Prompt injiziert, statt auf spontanes Lesen zu hoffen (OE-57). |

### 4.3 P2 — danach

| Maßnahme | Vorfall/Klasse | Inhalt |
|---|---|---|
| **Release-Versionsquelle projektseitig absichern** | V8 / F1, F4 | version-Datei statt `git describe` — als **Prompt-/Projekt-Konvention** (kuratierter Prompt leitet an, keine mads-Code-Änderung); Tag-Erreichbarkeit von `main` als Gate-Kandidat. |
| **`.mads/attachments`-Retention/Pruning** | V4 | Laufzeit-Artefakte altern und wachsen unbegrenzt; Retention-Policy + Pruning-Lauf. |
| **iOS-Timeline-Performance** | — | `LazyVStack` + Bild-Cache in der Companion-App ([[remote-companion-app]], separates Repo) — Betriebs-Komfort, keine Governance. |

---

## 5. Offene Entscheidungen

> Nummern **provisorisch bis zur README-Konsolidierung** (siehe Kopfblock; merge-time
> numbering). Alle mit gesetztem Default — die Roadmap ist dadurch nicht blockiert.

- **OE-53 Fremd-Edit-Schutz: Härtegrad** *(offen; Default gesetzt)*. Wenn der Worktree
  sich seit dem letzten Agent-Turn durch Dritte geändert hat: **Default: fail-closed** —
  Autopilot committet **nicht** und eskaliert (Befund: welche Pfade, seit wann).
  Alternative: warnen + nur die Agent-eigenen Pfade committen (selektives Staging statt
  `git add -A`) — komfortabler, aber die Zuordnung „eigener Pfad" ist selbst eine
  Ableitung, die irren kann (F1). (§4.2, V6)
- **OE-54 Worktree-Lock: Lebensdauer & Escape** *(offen; Default gesetzt)*. **Default:
  Lock während die Session läuft** (Start→Stop/Done), mit sichtbarem Force-Unlock im UI
  (der Mensch bleibt souverän, analog Instance-Lock). Alternative: Lock über die gesamte
  Stream-Lebensdauer (härter, aber nervt bei legitimen Menschen-Edits im pausierten
  Stream — [[07-file-explorer]] OE-35 erlaubt die ausdrücklich). (§4.2, V6)
- **OE-55 `.mads/gate.json`: Pflicht oder Fallback** *(offen; Default gesetzt)*.
  **Default: deklarierte Konfiguration hat Vorrang; Auto-Detect nur als Vorschlags-
  Generator beim Einrichten** (nie still als Gate). Offen: ob ein Projekt ohne
  `gate.json` gar kein Gate bekommt (ehrlich, aber hart) oder ein minimales
  Frozen-Install-Gate (nützlich, aber wieder Auto-Detect). Gegenprobe-Pflicht (F6) gilt
  in beiden Fällen. (§4.2, V10)
- **OE-56 Deploy-Abschluss: Signalquelle** *(offen; Default gesetzt)*. **Default:
  Korrelation Befehls-Start (`canUseTool`) → zugehöriges Task-Ende (Exit-Code des
  Background-Tasks)**; erst das Ende stempelt „abgeschlossen", der Exit-Code entscheidet
  Erfolg/Fehlschlag. Offen: Multi-Step-Deploys (mehrere Befehle = ein Deploy?) und
  Timeout-Semantik (nie endendes Task ⇒ Status bleibt „läuft", F1-konform). (§4.2, V7)
- **OE-57 Konventions-Injektion: Umfang** *(offen; Default gesetzt)*. **Default: nur
  Zeiger + Ein-Satz-Regeln** (CLAUDE.md-Auszug des Zielprojekts), keine Volltexte —
  Token-Kosten und Verdünnung sprechen gegen „alles rein". Offen: ob mads fehlende
  Zeiger im Zielprojekt aktiv anmahnt (Gate-Check „Konvention ohne CLAUDE.md-Verweis",
  die mechanische Antwort auf V5). (§4.2, V5)

---

## 6. Querverweise

- [[_paix-multi-agent-reference]] — die Invarianten, deren fehlende **Durchsetzung**
  (nicht: Dokumentation) die Wurzel von V6 war; Leitbild „mechanisch erzwingbar statt
  Disziplin".
- [[03-main-agent]] — Integrator-only-Merge, Vor-Merge-Gate, „der Integrator rät nicht"
  (deterministisch verweigern statt fail-open weitermachen — F1 ist die Verletzung genau
  dieses Prinzips).
- [[04-sub-agents]] — Lebenszyklus/Resume der Streams (V3, V9), Permission-Modell
  (`canUseTool`, V7).
- [[05-update-area]] — beobachtet genau die native Fähigkeits-Front aus §3.1;
  Versions-Pinning der SDK-/CLI-Fähigkeiten.
- [[06-ownership-and-coordination]] — Ownership-/Trespass-Modell: die Antwort auf
  Kollisionen **zwischen Streams**; dieses Doc ergänzt die Antwort auf Kollisionen
  **zwischen Stream und Außenwelt** (V6).
- [[02-dashboard]] — Eskalations-/Aktions-Flächen, auf denen F7 (Default-Aktion) lebt.
- [[remote-companion-app]] — iOS-Companion (P2-Eintrag Timeline-Performance).
- [[claude-code-capabilities]] — Recherche-Basis für §3.1 (dort zu aktualisieren, wenn
  sich die native Front weiterbewegt).
