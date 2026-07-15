# Multi-Agent-Parallelentwicklung — Leitfaden

> **Portabler Kern.** Die Sektionen 1–11 sind projekt-agnostisch und in anderen Repos
> wiederverwendbar. Die PAIX-spezifischen Werkzeuge und der konkrete CI-Fix stehen
> isoliert im **Appendix (Sektion 12)**. Wer dieses Dokument in ein anderes Projekt
> kopiert, löscht den Appendix und ersetzt ihn durch die eigenen Skripte.
>
> Dieses Dokument ist so konstruiert, dass es den dokumentierten Fehler-Fall verhindert:
> *Ein Sub-Branch wurde gegen einen weitergewanderten `main` veraltet (stale base) und
> überlappte eine geteilte Datei — Ergebnis: harter, rot-CI Merge.* Jede Regel hier
> greift entweder das **Zeitfenster** (Divergenz) oder den **Datei-Überlapp** an.

---

## 1. Zweck & wann Multi-Agent-Parallelentwicklung (und wann NICHT)

**Zweck.** Mehrere unabhängige Arbeitsströme gleichzeitig vorantreiben — jeder auf
eigener Branch in eigener, isolierter Working-Copy — ohne sich gegenseitig zu
kontaminieren, und am Ende sauber gegen einen immer-lauffähigen `main` integrieren.
Der Gewinn ist Durchsatz ohne Kontext-Switching-Steuer für den Menschen: parallele
Tracks statt sequenzieller.

**Wann JA:**

- Zwei bis drei **wirklich unabhängige Themen** (z. B. Feature A + Security-Findings),
  die jeweils eigene Branch und eigene Commits verdienen.
- Aufgaben, die sich entlang **Modul-/Datei-Grenzen** sauber zerschneiden lassen
  (vertikale Feature-Slices statt horizontaler Layer).
- Lang-laufende Arbeit, bei der ein Strom nicht auf den anderen warten muss.

**Wann NEIN (dann lieber sequenziell oder Sub-Agent-in-einer-Session):**

- Die Aufgaben **überlappen im Datei-Raum** (beide editieren dieselbe geteilte Datei
  / Registry / Lockfile). → Serialisieren, nicht parallelisieren.
- Eng gekoppelte Sub-Aufgaben innerhalb *einer* Gedanken-Einheit (z. B. „lass kurz
  den Reviewer das eben Geschriebene prüfen"). → Sub-Agent, der nicht committet und
  ein Resultat zurückgibt.
- Mehr als ~5 parallele Ströme: Koordinations-Overhead wächst schneller als der
  Durchsatz. Start mit **2–3**; der Engpass eines Solo-Maintainers ist
  **Review/Integration**, nicht die Spawn-Zahl.

**Anti-Pattern:** Zwei Agenten-Panels im *selben* Working-Tree. Das führt zu
`git add -A`-Kontamination (Fremd-Dateien werden gestaged), gegenseitigem Stören in
Quality Gates und schwer-zu-debuggenden Races. Isolation ist nicht verhandelbar.

---

## 2. Das Modell: Master-Stream (`main`) als Integrator + Sub-Agent-Branch-Streams

Die Topologie kombiniert drei etablierte Muster, die sich nicht widersprechen,
sondern komponieren:

- **Integration-Manager-Workflow** liefert das *Wer*: genau **ein** Akteur landet
  Commits auf der kanonischen Linie.
- **Trunk-Based Development** liefert das *Wie lange*: kurzlebige Branches (< 1 Tag),
  täglich rebaset, früh integriert.
- **GitHub-Flow / PR-Gate** liefert den *Mechanismus*: Merge erst nach Review + grünem CI.

### Rollen & Verantwortlichkeiten

| Rolle | Verantwortung | Darf NICHT |
| --- | --- | --- |
| **`main` (Master-Stream)** | Kanonische, **immer lauffähige** Linie. Einziges Merge-Ziel. Protected. | — |
| **Der Integrator** (ein benannter Mensch oder eine designierte Session) | **Der einzige**, der auf `main` landet. Bestimmt die Integrations-Reihenfolge. Löst Konflikte. | Keine rote CI / stale-base PR mergen. |
| **Sub-Streams** (`feat/<name>`) | Eine Aufgabe pro isolierter Working-Copy. Committet + pusht **die eigene Branch**, öffnet einen PR. | **Niemals selbst nach `main` mergen.** |

**Drei Invarianten, die alles zusammenhalten:**

1. **Only `main` merges.** Kein Sub-Stream landet je selbst auf `main`. Sub-Streams
   *schlagen vor* (PR), der Integrator *verfügt* (Merge).
2. **`main` is always runnable.** Jeder Merge passiert grünes CI; jeder, der auf
   `origin/main` rebaset, startet von einer bekannt-guten Basis.
3. **Subs never self-merge.** Auch nicht, wenn es „offensichtlich richtig" aussieht.
   Der Trigger für eine außen-sichtbare Aktion ist immer eine explizite Anweisung.

---

## 3. Kernprinzipien

1. **Kurzlebige Branches.** Ziel: < 1 Tag Lebensdauer, harte Decke wenige Tage.
   ≤ 3 aktive Branches gleichzeitig. Je länger eine Branch lebt, desto älter ihre
   Merge-Basis → desto mehr Hunks haben sich beidseitig geändert → desto mehr
   Konflikte. Divergenz kompoundiert; das ist die *formale* Ursache des Stale-Base-Schmerzes.
2. **Genau EIN Integrator merged.** Ein einziger Serialisierungs-Punkt, an dem
   Lauffähigkeit behauptet und Konflikte aufgelöst werden.
3. **Isolation via Worktrees.** Jeder Sub-Stream bekommt eine eigene Working-Copy +
   eigene Branch, teilt aber die Git-History. Kein `index.lock`-Kampf, keine
   unsichtbaren Fremd-Edits, keine `git add -A`-Kontamination.
4. **Contracts-first.** Geteilte Schnittstellen (API-Signaturen, DB-Schema,
   Event-/Datenformate) werden **vor** dem Coden in einem committeten Artefakt
   (ADR oder Stub-Datei) eingefroren. Agenten coden gegen den Vertrag — niemals gegen
   die unmerged Branch eines Geschwister-Stroms.
5. **CI-als-Gate.** Eine Branch ist erst merge-fähig, wenn sie identisches,
   deterministisches CI grün passiert. „Grün auf der Branch" zählt nur nach
   rebase-onto-fresh-main + frozen-Lockfile-CI.
6. **Lockfile-Determinismus.** Committetes Lockfile + *frozen* Installs in CI, damit
   `green-on-branch == green-on-main`. Die einzige Variable zwischen den beiden
   CI-Läufen darf der Code sein — nicht die aufgelösten Dependency-Versionen.

---

## 4. Setup: ein Worktree pro Sub-Stream

Ein Worktree ist ein **zweites Arbeitsverzeichnis** mit eigenem `HEAD`, eigenem Index
und eigener Working-Tree — aber **geteiltem Objekt-Store und Refs**. Ein Commit/Fetch
in einem Worktree ist sofort in allen anderen sichtbar (der entscheidende Vorteil
gegenüber mehreren Clones).

```bash
# Worktree-Container einmalig anlegen (AUSSERHALB des Repos, damit git ihn nicht
# in der Working-Tree-Suche sieht):
mkdir -p ~/worktrees

# Frische Basis holen, dann Worktree + kurzlebige Branch off origin/main:
git fetch origin
git worktree add -b feat/mail-composer ~/worktrees/mail-composer origin/main

# Worktrees auflisten (Pfad + HEAD + Branch; markiert 'locked'/'prunable'):
git worktree list

# Nach dem Merge aufräumen:
git worktree remove ~/worktrees/mail-composer   # verweigert bei dirty; -f erzwingt
git branch -d feat/mail-composer                # -d = safe, nur wenn merged
git worktree prune                              # fegt Geister-Metadaten weg
```

> **Helper-Skript:** Diese Schritte lassen sich in ein Wrapper-Skript packen
> (`new`/`list`/`remove`), das zusätzlich `.venv` per Symlink teilt, eine
> Editor-Akzentfarbe setzt und das Editor-Fenster öffnet. Siehe Appendix für die
> PAIX-Variante.

**Was geteilt vs. privat ist:**

| Geteilt über alle Worktrees | Privat pro Worktree |
| --- | --- |
| Objekt-DB `.git/objects/` (ganze History) | `HEAD` |
| Refs (Branches, Tags, Remotes), Stash, Reflog | Index |
| `.git/config`, Remote-/Fetch-Config | Working-Tree-Datei-Inhalte |
| **Hooks** (`.git/hooks`) | `MERGE_HEAD`, `CHERRY_PICK_HEAD` etc. |

> **Feinheit:** `.git/config` ist geteilt — *ausser* bei aktiviertem
> `extensions.worktreeConfig`, dann gelten `config.worktree`-Keys pro Worktree (z. B.
> `core.sparseCheckout`). `refs/bisect`, `refs/worktree`, `refs/rewritten` sind ebenfalls
> pro Worktree.

**Fallstricke, die Isolation NICHT abdeckt** (selbst lösen):

- **Dieselbe Branch in zwei Worktrees** wird verweigert — das ist ein Feature.
  Andere Branch nehmen.
- **Runtime-State** (Ports, DBs, Caches, `.env`, Build-Artefakte) ist *nicht*
  isoliert. Zwei Worktrees binden beide `localhost:3000`. Per-Worktree-Ports/DB selbst
  setzen.
- **Untracked Dependency-Dirs** (`.venv`, `node_modules`) verwaltet git nicht.
  Ein **symlinkter** geteilter `.venv` ist nur korrekt, solange alle Worktrees
  *denselben* gepinnten Dependency-Set teilen. **Sobald ein Worktree `pyproject.toml`
  / Lockfile ändert: Symlink dort droppen und ein privates `.venv` synchronisieren** —
  sonst schreibt der Install den geteilten Env hinter dem Rücken der anderen Sessions um.
- **Stale Worktrees** (mit `rm -rf` gelöscht) hinterlassen Metadaten und verlangsamen
  git. Immer `git worktree remove`, periodisch `git worktree prune`.

---

## 5. Der Lebenszyklus (end-to-end)

```bash
# 1) WORKTREE ANLEGEN — eine Aufgabe, eigene Branch, off frischem main
git fetch origin
git worktree add -b feat/mail-composer ~/worktrees/mail-composer origin/main

# 2) DEN CONTRACT / SCOPE VEREINBAREN (bevor Code geschrieben wird)
#    - Welche Dateien gehören dieser Branch? (Ownership-Map, Sektion 6)
#    - Welche geteilten Schnittstellen sind eingefroren? (ADR / Stub-Datei)
#    Keine zwei Branches mit überlappenden Datei-Listen parallel.

# 3) IN KLEINEN COMMITS ARBEITEN (Ziel < ~200 Zeilen/PR; Konflikt-Wahrscheinlichkeit
#    steigt ~3x von winzigen zu mittleren PRs). Neue Dateien bevorzugen statt geteilte
#    zu modifizieren.

# 4) IN SYNC BLEIBEN — rebase-onto-main mindestens täglich (mehr, wenn main heiss ist).
#    DAS verhindert die stale base:
git fetch origin
git rebase origin/main             # kleine, häufige Rebases = winzige Konflikte
# Konflikte JETZT lösen, lokal, solange sie klein sind. (git rerere replayt Wiederholer.)
# Wenn die Branch schon gepusht war, hat der Rebase die History umgeschrieben:
git push --force-with-lease        # NUR nach einem History-umschreibenden Rebase

# 5) QUALITY GATES LOKAL, auf der NEUEN Basis (pro Worktree unabhängig):
#    <lint> && <type-check> && <tests>     # z. B. ruff && mypy --strict && pytest
#    Frozen-Lockfile-Install, damit der lokale Lauf das CI vorhersagt.

# 6) PR ÖFFNEN — main ist das EINZIGE Merge-Ziel:
git push -u origin feat/mail-composer        # ERSTER Push: plain (nichts zu forcen)
gh pr create --base main --head feat/mail-composer --fill

# 7) MASTER INTEGRIERT (Sektion 7): rebase-before-merge, sequenzielle Reihenfolge,
#    nie eine rote-CI oder stale-base PR. Squash hält main linear & jeden Commit lauffähig:
gh pr merge --squash --delete-branch

# 8) WORKTREE + BRANCH AUFRÄUMEN:
git worktree remove ~/worktrees/mail-composer
git branch -d feat/mail-composer
git worktree prune
```

**Cadence (die Disziplin, die alles trägt):**

| Aktivität | Frequenz |
| --- | --- |
| Sub-Branch onto `origin/main` rebasen | mindestens 1×/Tag |
| Sub-Branch → `main` mergen | sobald grün + reviewed; Ziel < 1 Tag Lebensdauer |
| Branch-Teardown | sofort nach Merge |
| Lang-lebende Branches | **keine** ausser `main` |

---

## 6. Konfliktvermeidung BY DESIGN

Der höchste Hebel liegt nicht im Konflikt-Lösen, sondern in der **Task-Dekomposition**:
Gestalte die *Aufgaben* so, dass zwei Branches selten dieselbe Datei berühren.
*„Different files = different git objects = zero overlap."*

**Drei Design-Muster:**

1. **Neue Dateien bevorzugen** statt geteilte zu modifizieren. Task A → `module_a.py`,
   Task B → `module_b.py`. Temporäre Duplikation akzeptieren, später konsolidieren.
2. **Vertikale Feature-Slices statt horizontaler Layer.** Ein Strom besitzt die ganze
   Stack-Scheibe seines Features (Daten + Logik + UI), nicht alle Ströme editieren
   denselben Layer aus verschiedenen Richtungen.
3. **Cross-cutting Änderungen aufschieben** (Import-Wiring, zentrale Registry-Einträge)
   → in einen finalen Integrations-Schritt, nicht über jede Branch verstreut.

**Ownership-Map.** Vor dem Spawnen eine Tabelle bauen: jede Zeile =
(Aufgabe, Owner-Branch, berührte Dateien, Exit-Kriterium). **Überlappende
Datei-Listen → serialisieren, nicht parallelisieren.** In `CODEOWNERS` kodiert wird
der Überlapp mechanisch erkennbar, nicht nur narrativ.

### Protokoll für eine unvermeidbare geteilte Datei-Edit

Manchmal *müssen* zwei Aufgaben dieselbe Datei (geteiltes Modul, zentrale Registry,
`pyproject.toml`, Lockfile) berühren. Dann **genau eine** der zwei Optionen — niemals
beide Branches parallel editieren lassen:

**Option A — Zuerst auf `main` landen (bevorzugt).**

1. Die geteilte Änderung als *winzigen, eigenständigen* PR (nur die geteilte Edit,
   sonst nichts).
2. Sofort nach `main` mergen.
3. Beide Feature-Branches rebasen auf das neue `main` → sie *enthalten beide bereits*
   die geteilte Änderung → kein Konflikt auf dieser Datei.

**Option B — Genau EINEN Owner-Branch für die Datei benennen.**

Branch A ist der einzige Editor von `shared.py` (in `CODEOWNERS` oder im Task-Brief
festgehalten). Branch B berührt `shared.py` *nicht*; braucht B eine Änderung dort,
fordert sie A an oder wartet, bis A gelandet hat. A wird in der Integrations-Reihenfolge
*zuerst* sequenziert.

**Entscheidungsregel:** geteilte Änderung klein & self-contained → **Option A**.
Groß & mit der Logik eines Tasks verflochten → **Option B**.

> **Der reale Fehler-Fall (genau dieses Protokoll hätte ihn verhindert).**
> Zwei Branches editierten dasselbe geteilte Modul (`src/paix/mail/body_render.py`).
> Branch X branchte von einem Commit, danach wanderte `main` weiter — u. a. mit einem
> Commit, der *ebenfalls* `body_render.py` anfasste. Branch X wurde nie nachgezogen
> (kein Rebase). Bei der Integration: stale base + Datei-Überlapp = harter,
> rot-CI Merge. **Korrekt wäre gewesen:** die geteilte Datei-Änderung *einmal* früh
> auf `main` landen (Option A) ODER einem Branch als alleinigem Owner zuweisen
> (Option B) — und Branch X täglich auf `origin/main` rebasen, statt veralten zu lassen.

---

## 7. Die Integrations-/Merge-Prozedur (der Job des Masters)

Wenn N Branches fertig sind: **nicht** simultan mergen. **Serialisieren.**

```text
1. Branch A wählen. A onto current main rebasen, CI re-run, A → main mergen.
2. main hat jetzt VORGERÜCKT. Branch B onto das NEUE main rebasen.
   → Konflikte (falls vorhanden) HIER lösen, CI re-run, B → main mergen.
3. Branch C onto das neue-neue main rebasen. Wiederholen.
```

**Regeln des Integrators:**

- **Integrations-Reihenfolge:** Die Branch, die geteilten/fundamentalen Code anfasst
  (Schema, geteiltes Modul, Lockfile), **zuerst** landen. Dann die abhängigen.
  Dependency-Reihenfolge: Schema → API → UI. Modelliere abhängige Arbeit als *Stack*,
  nicht als N unabhängige PRs, die ums Landen rennen. **Tie-Break** bei zwei
  gleichwertigen Branches am geteilten Code: die mit dem *kleineren Diff* / weniger
  Down-stream-Abhängigkeiten zuerst.
- **Rebase-before-merge:** Der Integrator rebaset *jede* Branch auf das neue `main`
  *bevor* er sie merged, lässt CI auf der neuen Basis re-run, dann landet er. So
  integriert jede Arbeit gegen die *Realität*, nicht gegen ihre stale Basis.
- **Wer löst Konflikte:** Der Integrator, an genau diesem einen Punkt — aber nur
  **mechanische/textuelle** Konflikte. Braucht die Auflösung **Domänen-Wissen**
  (semantischer Konflikt: der Code merged textuell sauber, ist aber logisch falsch),
  geht die Branch zurück an den Sub-Stream-Owner zum Rebase. Der Integrator *rät nicht*.
  Produzierende Ströme mergen nie selbst nach `main`.
- **Nie mergen:** keine rote-CI PR. Keine stale-base PR (nicht auf aktuelles `main`
  rebaset). Im Zweifel: zurückschicken zum Rebase-und-CI-re-run.
- **Squash bevorzugt** für Agenten-Branches: hält `main` linear und jeden Commit
  unabhängig lauffähig (gut für `git bisect` und die „main always runnable"-Invariante).

> **Optional, ab ≥ 2 PRs/Stunde, die ums Landen rennen:** eine stack-aware
> **Merge-Queue** automatisiert genau diese Serialisierung — sie testet den
> *would-be-merged*-Zustand (latestes `main` + alle PRs davor in der Queue), sodass
> „grün auf meiner Branch" durch „grün, wenn tatsächlich mit `main` kombiniert"
> ersetzt wird. Für einen Solo-Maintainer mit < 2 racing PRs ist die manuelle
> rebase-onto-fresh-main + CI-re-run-Disziplin 90 % des Nutzens.

**Recovery, wenn eine Branch *doch* veraltet ist** und der Rebase zu groß wird:
`git imerge` zerlegt den Merge in minimale, **nie zweimal gezeigte**, unterbrechbare
Konflikt-Paare (bisect-basiert) — der schonende Ausweg aus genau der Lage, die dieses
Dokument verhindern will. Besser ist, gar nicht erst dorthin zu kommen (Sektion 1, 5).

---

## 8. Koordination über committete Artefakte

Geteilter Zustand lebt in versionierten Dateien — nicht in Out-of-band-Chat. So
überlebt er Agenten-Resets und ist auditierbar.

- **ADRs (`docs/decisions/`)** — Entscheidungen, eingefrorene Schnittstellen,
  neue Invarianten. Eine Contract-Änderung mid-flight ist ein *Stop-the-world*-Ereignis:
  ADR updaten, alle abhängigen Ströme benachrichtigen, re-baseline — niemals eine
  Branch still eine geteilte Signatur ändern lassen.
- **Backlog / Task-State-Datei** — wer besitzt was, Status, Abhängigkeiten.
  Ein Strom *claimt* eine Aufgabe (schreibt seine ID / setzt Status), *bevor* er beginnt.
- **Plan-/Progress-Dateien** — Handoffs passieren über committete Report-Artefakte,
  nicht über Messaging.
- **Human-curated Brief.** Der geteilte Projekt-Brief (z. B. `CLAUDE.md`/`AGENTS.md`)
  ist mensch-besessen — Agenten *lesen* ihn, schreiben ihn nicht um. Auto-generierte
  geteilte Kontext-Dateien kompoundieren Fehler.

**Warnung:** Append-Punkte wie ADR-Listen, `BACKLOG.md`, `SECURITY_AUDIT.md` werden
*textuell konfligieren*, wenn zwei Ströme gleichzeitig anhängen. Halte parallele
Worktrees auf möglichst *disjunkten* Datei-Sets; behandle diese Append-Dateien selbst
nach dem Protokoll aus Sektion 6.

---

## 9. CI & Determinismus

„Grün auf meiner Branch" kann `main` trotzdem brechen, wenn die zwei Läufe
*unterschiedliche* Dependency-Versionen aufgelöst haben. Diese Lücke schließen:

- **Lockfile committen** (z. B. `uv.lock`, `package-lock.json`, `pnpm-lock.yaml`).
- **CI installiert *frozen*, löst nie auf.** Ein nicht-frozen Install kann still eine
  neuere-aber-kompatible Version ziehen, die zwischen zwei Läufen publiziert wurde
  → flakiges, nicht-reproduzierbares CI.

| Ökosystem | Frozen-CI-Befehl |
| --- | --- |
| uv (Projekt-venv) | `uv sync --locked` (assertet auch, dass das Lock zu `pyproject.toml` passt) — Tools dann via `uv run …` |
| uv (System-Install, kein venv) | `uv export --frozen … -o req.txt` + `uv pip install --system -r req.txt` |
| npm | `npm ci` |
| yarn | `yarn install --frozen-lockfile` |
| pnpm | `pnpm install --frozen-lockfile` |

> **uv-Fallstrick (wichtig):** `uv sync` kennt **kein** `--system` (installiert nur in ein Projekt-`.venv`), und `uv pip install` liest `uv.lock` **gar nicht** (es resolved frisch aus `pyproject.toml`) — `--frozen` dort ist wirkungslos. Ein `--system`-CI wird daher *nicht* mit `uv sync --locked` deterministisch, sondern nur über den Export-Pfad oben (oder durch Umstieg auf `uv run` + Projekt-`.venv`). Flags gegen die aktuelle uv-Version verifizieren — uv entwickelt sich.
>
> **Zweite Determinismus-Achse:** Frozen-Lockfile pinnt *Paket-Versionen*, nicht den *Interpreter*. Eine Test-Matrix (z. B. Python 3.11/3.12) ist eine bewusste zweite Achse; die Garantie gilt pro Interpreter-Version.

**Warum load-bearing:** Mit committetem Lock + frozen CI ist die *einzige* Variable
zwischen dem CI der Branch und dem CI von `main` der Code selbst. Damit ist ein
rebase-onto-fresh-main-Re-run ein *vertrauenswürdiger* Prädiktor für den
Post-Merge-Zustand von `main`. Lockfile-Änderungen werden außerdem zu einer *Datei*,
die dem Shared-File-Protokoll aus Sektion 6 folgt: bumpen zwei Branches Dependencies,
ist das ein geteilter Datei-Edit — zuerst landen oder einem Owner geben.

> **Periodischer Upgrade-Job.** Frozen-CI heißt nicht *nie* upgraden. Ein separater,
> *gescheduleter* Job (nicht der pro-PR-Pfad) löst das Lockfile neu auf, lässt die
> volle Test-Suite laufen und öffnet einen PR mit dem aktualisierten Lock. So bleibt
> der pro-PR-Pfad deterministisch und Upgrades sind eine bewusste, reviewte Aktion.

**`git rerere` (einmal global einschalten):** Git zeichnet auf, wie du einen Konflikt
gelöst hast, und replayt dieselbe Lösung beim nächsten Auftreten — unbezahlbar, wenn
du dieselbe Branch wiederholt auf ein bewegliches `main` rebaset.

```bash
git config --global rerere.enabled true
```

---

## 10. Anti-Patterns

- ❌ **Zwei Agenten im selben Working-Tree.** `git add -A`-Kontamination, Quality-Gate-
  Störung, Stick-Sync/Push-Races. Immer Worktrees.
- ❌ **Lang-lebende Branches.** Divergenz kompoundiert; Risiko wird auf den schlimmsten
  Moment (Merge-Zeit) verschoben. Decke: < 1–2 Tage.
- ❌ **Stale Base ignorieren.** Eine Branch nicht täglich rebasen → „grün auf meiner
  Branch" lügt, weil sie gegen ein *altes* `main` getestet wurde.
- ❌ **Zwei Branches editieren dieselbe Datei parallel.** Der dokumentierte Fehler-Fall.
  Land-first oder Single-Owner (Sektion 6).
- ❌ **N Branches simultan mergen.** Immer serialisieren (Sektion 7).
- ❌ **Rote-CI oder stale-base PR mergen.** Der Integrator lehnt ab.
- ❌ **Sub-Stream merged selbst nach `main`.** Nur der Integrator landet.
- ❌ **Public/shared History rebasen.** *Niemals* Commits rebasen, auf die andere ihre
  Arbeit gestützt haben. Eigene unshared Branch rebasen ist frei; in eine Branch, auf
  der andere bauen, `main` *hinein*-mergen.
- ❌ **`git push --force`** statt `--force-with-lease`. Force-with-lease bricht ab, wenn
  das Remote unerwartet weitergewandert ist.
- ❌ **Nicht-frozen Installs in CI.** Nicht-deterministisch; bricht
  green-branch ⇒ green-main.
- ❌ **Unkoordinierte Lockfile-/Migrations-Edits.** Single-Owner, durch eine FIFO.
- ❌ **Stale Worktrees mit `rm -rf` löschen.** `git worktree remove` + `prune`.
- ❌ **Geteilten `.venv` mutieren, wenn Deps abweichen.** Symlink droppen, privates
  `.venv` für diesen Worktree.
- ❌ **Annehmen, Worktrees lösen Konflikte.** Sie isolieren nur den Workspace.
  Semantische Konflikte und Korrektheit bleiben deine Aufgabe — Tests sind das echte Gate.

---

## 11. Schnell-Referenz / Checkliste

```text
SETUP (einmal)
[ ] git config --global rerere.enabled true        # Wiederholer-Konflikte auto-replayen
[ ] Lockfile committen. CI nutzt frozen/locked install (kein Re-resolve).
[ ] Branch-Protection auf main: PR-only, required green CI, required review.
[ ] Optional: CODEOWNERS (Modul → Owner); Merge-Queue ab ≥2 racing PRs/Stunde.

PLANUNG (vor dem Dispatchen paralleler Arbeit)
[ ] Aufgaben entlang Modul-/Datei-Grenzen zerschneiden (vertikale Slices). 1 Branch ≈ 1 Lane.
[ ] Neue Dateien bevorzugen statt geteilte editieren. Import/Config-Wiring aufschieben.
[ ] Geteilte-Seam-Dateien identifizieren: pyproject/lockfile, i18n, zentrale Registries.
[ ] Pro geteilter Datei: zuerst auf main landen (winziger PR) ODER genau EINEN Owner.
[ ] ≤3 aktive Branches; jede binnen Stunden/1 Tag mergen.

CREATE
git fetch origin
git worktree add -b feat/<task> ~/worktrees/<task> origin/main

SYNC (tötet den stale-branch CI-Fehler — mindestens täglich)
git fetch origin
git rebase origin/main                              # klein & häufig = winzige Konflikte
git push --force-with-lease                         # NUR wenn die Branch schon gepusht war

GATE (auf der NEUEN Basis, frozen install)
<lint> && <type-check> && <tests>                   # z. B. ruff && mypy --strict && pytest

PR (main ist das EINZIGE Merge-Ziel)
git push -u origin feat/<task>                      # erster Push: plain
gh pr create --base main --head feat/<task> --fill

INTEGRATE (serialisieren, nie parallel-mergen)
[ ] Reihenfolge: geteilte/fundamentale Branch ZUERST
[ ] Rebase auf frisches main → CI re-run → mergen → main rückt vor
[ ] Nächste Branch onto das NEUE main rebasen → Wiederholen
gh pr merge --squash --delete-branch

CLEANUP
git worktree remove ~/worktrees/<task>
git branch -d feat/<task>
git worktree prune

GOLDENE REGELN (nie brechen)
[ ] Nie Commits rebasen, auf die andere gebaut haben.
[ ] Eigene unshared Branch frei rebasen; main IN eine geteilte Branch mergen.
[ ] Nie zwei Branches dieselbe Datei parallel editieren — land-first oder single-owner.
[ ] "Grün auf meiner Branch" zählt erst nach rebase-onto-fresh-main + frozen-CI.
[ ] Nur der Integrator landet auf main. Nie rote-CI / stale-base mergen.
```

---

## 12. Appendix: PAIX-spezifisch

> Dieser Appendix referenziert **real existierende** Skripte und den realen CI-Fix aus
> dem PAIX-Audit. Beim Wiederverwenden des Leitfadens in einem anderen Projekt:
> diesen Appendix löschen oder durch die eigenen Werkzeuge ersetzen.

### 12.1 Worktree-Lifecycle — `scripts/paix-worktree.sh`

Wrapt die generischen `git worktree`-Befehle aus Sektion 4/5:

```bash
# Aus dem Main-Checkout:
scripts/paix-worktree.sh new mail-composer                   # green (default)
scripts/paix-worktree.sh new security-f-007 --colour orange  # eigene Akzent-Farbe
scripts/paix-worktree.sh list                                # aktive Worktrees
scripts/paix-worktree.sh remove mail-composer                # refuse bei dirty (ausser --force)
```

`new` legt den Worktree unter `~/paix-worktrees/<name>` an, erstellt Branch
`feat/<name>` (override via `--branch`), **symlinkt `.venv`** aus dem Main-Checkout
(`ln -s "$REPO_ROOT/.venv" "$path/.venv"`), schreibt `.vscode/settings.json` mit
Akzent-Farbe (green/orange/purple/teal/red) und öffnet automatisch ein VS-Code-Fenster
(deaktivierbar via `--no-open` oder `PAIX_WORKTREE_NO_OPEN=1`).
`remove` prüft auf Uncommitted Changes (refuse ausser `--force`), entfernt den Worktree
und löscht die Branch via `git branch -d` (nur wenn merged).

> **Symlink-`.venv`-Disziplin:** korrekt, *weil* alle Worktrees denselben gepinnten
> Dependency-Set via dasselbe `uv.lock` teilen. Sobald ein Worktree `pyproject.toml` /
> `uv.lock` ändert: Symlink dort droppen und `uv sync` ein privates `.venv` für diesen
> Worktree allein.

### 12.2 Session-Ende-Cleanup — `scripts/paix-session-cleanup.sh`

Zwei-Schritt, das Trigger-Pattern wie bei `paix-commit.sh`:

```bash
scripts/paix-session-cleanup.sh status     # read-only Diagnose, Exit 0 = clean, 1 = Punch-Liste
scripts/paix-session-cleanup.sh go --yes   # nur nach expliziter User-Autorisierung
```

`status` prüft mechanisch: Main-Checkout (uncommitted, ahead/behind `origin/main`),
Stick-Sync (pending Files), jeden Worktree (uncommitted, unpushed, merged-Check via
`git merge-base --is-ancestor`). `go` re-runt `status`, verweigert wenn nicht clean
(kein `--force`-Override), und räumt pro gemerged-cleanem Worktree auf:
`git worktree remove` + lokale Branch löschen + `git push origin --delete <branch>`.

### 12.3 Die „Stick-Sync nur aus main"-Regel

`scripts/paix-stick-sync.sh` rsynct `src/paix/` auf den Production-Stick. **Niemals
aus einem Feature-Branch / Worktree syncen** — der Stick repräsentiert produktiven
Stand. Erst nach Merge zurück nach `main`, *dann* `scripts/paix-stick-sync.sh sync`
aus dem Main-Checkout. Das Skript hat einen Live-PAIX-Guard (refuse, wenn PAIX vom
Stick auf Port 8765 läuft, ausser `--force`) und löscht `__pycache__` nach dem Sync.
Diese Regel ist die PAIX-Instanz der „only main is the source of truth for
production"-Invariante aus Sektion 2.

### 12.4 Lokaler Dev-Modus — `scripts/paix-dev.sh`

Ersetzt für UX-Polish-Iterationen den Sync-zentrierten Zyklus durch
Edit → Browser-Refresh. PAIX läuft mit `PAIX_HOME=~/.paix-dev/` aus dem Repo-Code,
mit einem isolierten rsync-Snapshot der Stick-Daten:

```bash
scripts/paix-dev.sh seed-from-stick    # Einbahn: /Volumes/PAIX-AI → ~/.paix-dev
scripts/paix-dev.sh start              # PAIX aus Repo-Code auf Port 8765
scripts/paix-dev.sh status             # Dev-Umgebungs-Übersicht
```

`seed-from-stick` ist **Einbahn** (Stick → Dev-Dir); es gibt bewusst keinen
`dev-to-stick`-Befehl. Production-Stick wird nie angefasst. Pro Worktree eine eigene
Sandbox via `PAIX_DEV_HOME`.

### 12.5 Der reale CI-Fix: Lockfile-getriebenes CI (verhindert den dokumentierten Fehler)

**Befund aus dem Audit (PR #3):** `.github/workflows/ci.yml` installierte in allen drei
Jobs (lint, type-check, test) mit:

```yaml
uv pip install --system -e ".[dev]"        # FALSCH: re-resolved, ignoriert uv.lock
```

Das **re-resolvt Dependencies zur CI-Laufzeit** und ignoriert das committete `uv.lock`.
Folge: „Schrödinger's Test" — Code passt lokal (mit gelocktem `.venv`), fällt aber im CI
(mit re-resolvten Versionen), oder umgekehrt. Konkret schlug `mypy --strict` fehl, weil
Type-Stubs nicht zur re-resolvten Library-Version passten (z. B. `bs4 4.15` vs.
`find_all(hidden=...)`, `cryptography` `private_bytes_raw()`). Kombiniert mit der stale
base auf `body_render.py` ergab das einen harten, rot-CI Merge.

**Der Fix — eine der zwei Formen.** Achtung: `uv sync` kennt **kein** `--system`, und
`uv pip install --frozen` honoriert `uv.lock` **nicht** (siehe uv-Fallstrick in Sektion 9).
Das aktuelle CI installiert systemweit, also greift `uv sync --locked` *nicht* als
Drop-in — man wählt:

```yaml
# Option A — chirurgisch, behält --system: Lock in eine requirements-Datei materialisieren
- run: uv export --frozen --no-emit-project --extra dev -o requirements.txt
- run: uv pip install --system -r requirements.txt
- run: uv pip install --system --no-deps -e .     # Projekt selbst; Deps schon gepinnt

# Option B — sauberste: --system fallen lassen, Projekt-.venv + uv run (grösserer Diff:
# jeder Tool-Step wird zu `uv run …`)
- run: uv sync --locked --extra dev
- run: uv run ruff check .
- run: uv run mypy src tests
- run: uv run pytest
```

Option B ist der idiomatische uv-Projekt-Weg und entfernt den `--system`-Fallstrick ganz;
Option A ist der minimale Diff. So oder so ist CI ans committete `uv.lock` gebunden, und
`green-on-branch == green-on-main` gilt tatsächlich — die Voraussetzung dafür, dass ein
rebase-onto-fresh-main-Re-run (Sektion 5/7) den Post-Merge-Zustand verlässlich vorhersagt.

> **Hinweis:** Das ursprüngliche Audit hatte hier `uv sync --system --frozen` vorgeschlagen —
> eine **ungültige** Invocation (`uv sync` hat kein `--system`). Der adversariale Review-Pass
> hat das gefangen; genau dafür ist er da.

### 12.6 Worktrees vs. Sub-Agenten in PAIX

| Werkzeug | Wann |
| --- | --- |
| **Worktrees + separate Fenster** (`paix-worktree.sh`) | Unabhängige, langlaufende Aufgaben mit eigener Branch + Commits. |
| **Sub-Agent via Agent-Tool** | Tightly-coordinated Sub-Aufgaben in *einer* Session; Sub-Agent committet nicht, gibt Resultat zurück (z. B. `security-reviewer` vor dem PR). |
| **Zwei Panels im selben Working-Tree** | **Nicht empfohlen** — `git add -A`-Kontamination, Quality-Gate-Störung, Sync-Races. |
