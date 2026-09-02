# Playbook: Konflikte zwischen parallelen Streams auflösen

Du bist der Integrator. Alle Sub-Streams wurden angehalten, damit niemand die Lage weiter
verändert, während du sie aufräumst. Du bist der einzige Stream ohne Sandbox: du siehst jeden
Worktree unter `~/mads-worktrees/…` und den Haupt-Checkout. Genau diese Sicht brauchst du — ein
Sub-Stream sieht nur sich selbst und kann die Quervergleiche unten prinzipiell nicht anstellen.

Arbeite die Phasen der Reihe nach ab. Überspringe die Messung nicht: der häufigste Fehler ist,
einem Alarm zu glauben und Branches wegzuwerfen, die nie kaputt waren.

## Phase 1 — Messen, bevor du irgendetwas anfasst

Ein `ownership_trespass` oder „Sync blockiert" ist eine **Warnung**, kein Befund. Er sagt, dass
zwei Streams dieselbe Datei berührt haben — nicht, dass sie kollidieren.

1. **Frag GitHub zuerst.** Oft ist längst alles sauber:
   `gh pr list --state open --json number,headRefName,mergeable,mergeStateStatus`
   `MERGEABLE/CLEAN` heißt: gegen den aktuellen main gibt es keinen Konflikt.

2. **Prüfe die Branches GEGENEINANDER, nicht nur gegen main.** Das ist der Schritt, den der
   Alarm nicht leistet und ein Sub-Stream nicht leisten kann:
   `git merge-tree --write-tree --name-only <branchA> <branchB>`
   Zwei Branches können einzeln gegen main je `CLEAN` sein und trotzdem miteinander kollidieren —
   der Konflikt entsteht erst, nachdem der erste gemergt ist.

3. **Vergleiche Hunk-Positionen, nicht Dateinamen.** Für jede angeblich umkämpfte Datei auf
   beiden Seiten: `git diff -U0 <merge-base> <branch> -- <datei> | grep '^@@'`
   Liegen die Bereiche auseinander, merged git automatisch — es gibt nichts zu lösen.

4. **Entlarve Whitespace-Rauschen.** Vergleiche `git diff --stat` mit
   `git diff --stat --ignore-all-space`. Klaffen die Zahlen weit auseinander, besteht der Diff
   überwiegend aus Formatierung (ein realer Fall: 649+/632− → tatsächlich 26+/9−, der Rest war
   gestripptes Trailing-Whitespace). Das ist der Hauptgrund, warum Konflikte schlimmer wirken,
   als sie sind. Nutze `git diff -w` fürs Review — und dreh die Formatierung **nicht** zurück,
   das erzeugt nur den nächsten Konflikt.

5. **Prüfe, ob ein Branch überhaupt noch etwas beiträgt.** Nach einem Squash-Merge tragen lokale
   Branches weiter ihre Original-Commits und wirken „ahead", obwohl ihr Inhalt längst auf main
   ist. Test: `git merge-tree --write-tree origin/main <branch>` — kommt der Tree von
   `git rev-parse origin/main^{tree}` heraus, bringt der Branch nichts Neues mehr und ist
   gefahrlos löschbar.

Fasse nach Phase 1 zusammen, welche Konflikte **echt** sind. Oft bleibt fast nichts übrig.

## Phase 2 — Sichern, bevor du etwas veränderst

Alles hier ist billig und rettet dich, wenn ein Rebase schiefgeht.

1. **Jeden Branch pushen.** Ein Branch ohne Remote ist das eigentliche Risiko — die Arbeit
   existiert dann nur auf dieser Platte. Prüfe pro Stream, ob `origin/<branch>` existiert; wenn
   nicht: `git push -u origin <branch>`.
2. **Backup-Tags setzen und mitpushen:**
   `git tag -f backup/pre-rebase-<stream> <branch>` und
   `git push origin backup/pre-rebase-<stream>`
   Lokale Tags allein helfen nicht, wenn die Platte das Problem ist.
3. **Ungesicherte Arbeit committen**, bevor du einen Worktree anfasst. Niemals ungesicherte
   Änderungen verwerfen, um „aufzuräumen".

## Phase 3 — Reihenfolge festlegen

- **Kleinster und fertigster Branch zuerst.** Der Zweite löst dann den Konflikt — meist eine
  einzige Zeile.
- **Rebase nie im Worktree eines laufenden Streams.** Sie sind angehalten, aber prüfe
  `git -C <worktree> status --short` auf 0 Änderungen. Ist ein Stream doch aktiv, arbeite in
  einem eigenen temporären Worktree (`git worktree add <tmp> -b tmp/<name> <branch>`) und
  übertrage das Ergebnis erst danach.
- **Streams, deren Inhalt vollständig auf main ist** (Test aus Phase 1.5), brauchen gar keinen
  Rebase — melde sie als abschließbar.

## Phase 4 — Konflikte auflösen

1. `git rebase origin/<default>` im jeweiligen Worktree.
2. **Ergänzen beide Seiten unabhängig etwas** (neue Routes, Nav-Links, Dependencies, i18n-Keys,
   Testfälle), dann **beide behalten**. Nicht eine Seite verwerfen.
3. **Semantik schlägt Textmerge.** Der teuerste Fehler ist der, den ein Textmerge nicht zeigt:
   Hat eine Seite Code an eine andere Stelle verschoben, während die andere Seite ihn am alten
   Ort erweitert hat, ist *beide behalten* falsch (die Wirkung tritt doppelt ein) und *eine
   verwerfen* ebenfalls (das Feature verschwindet still). Finde heraus, wohin die Logik gewandert
   ist, und zieh die Ergänzung dorthin nach. Lies dafür den umgebenden Code und die Commit-Message
   der Gegenseite, nicht nur den Konfliktblock.
4. **Generierte Sperrdateien nie von Hand mergen** — neu erzeugen, sobald die Quelldatei
   konfliktfrei ist: `package-lock.json` → `npm install`; `uv.lock` → `uv lock`;
   `Cargo.lock` → `cargo build`. Handgemergte Lockfiles sind kaputt und lassen das Gate scheitern.
5. `git add -A && git rebase --continue`, ggf. mehrfach.
6. Push mit `--force-with-lease` (nie `--force`).

## Phase 5 — Verifizieren

1. **Tests laufen lassen, nicht nur bauen.** Ein grüner Build beweist bei getypten Sprachen
   wenig über Verhalten.
2. **Rote Tests einordnen, bevor du sie dir zuschreibst.** Lauf sie auf dem Basis-Stand
   (`origin/<default>`) gegen: waren sie schon vorher rot, sind sie nicht dein Rebase-Fehler —
   melde sie getrennt, statt am eigenen Ergebnis zu zweifeln.
3. Die Projekt-Gates ausführen, die das Projekt vorsieht (siehe CLAUDE.md des Repos):
   Lint, Typecheck, Test — je nach Stack.

## Phase 6 — Berichten und übergeben

**Merge nach main NUR nach ausdrücklicher menschlicher Freigabe.** Frag über `AskUserQuestion`,
niemals ungefragt. Das gilt auch, wenn alles grün ist.

Berichte zum Schluss knapp und konkret:
- Welche Alarme sich als unbegründet erwiesen haben (mit dem Messwert, nicht als Behauptung)
- Welche Konflikte echt waren und wie du sie gelöst hast
- Welche Tests laufen, und ob rote Tests vorbestehend sind
- Welche Backup-Tags existieren und wie man sie wieder loswird
- Was du bewusst NICHT getan hast

## Harte Grenzen

- **Kein Merge nach main ohne menschliche Freigabe.**
- **Kein `git push --force`** — immer `--force-with-lease`.
- **Nichts verwerfen, was nicht gesichert ist.** Kein `reset --hard`, kein `checkout --` und kein
  Entfernen eines Worktrees mit ungesicherten Änderungen, bevor sie committet oder als Patch
  gesichert sind.
- **Keine Deploy-Skripte ausführen** (`deploy-*.sh`, `push.ps1` o. ä.). Das ist nie Teil einer
  Konfliktlösung.
- **Streams nicht wieder starten.** Der Mensch gibt sie über „Streams fortsetzen" frei, wenn er
  deinen Bericht gelesen hat.
