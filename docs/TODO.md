# mads — offene UX-/Workflow-Aufgaben

Vorgemerkt aus einer Session (2026-06-22). Beide entstanden aus echten Praxis-Fällen
beim Multi-Agent-Lauf gegen das paix-Repo.

## 1. Geführtes „Konflikt lösen" statt Sync-Sackgasse

**Problem.** Wenn Auto-Sync auf einen echten Rebase-Konflikt stößt, bricht es den Rebase
ab und eskaliert (`merge_conflict`, Auto-Sync pausiert via `autoSyncConflicted`).
Der manuelle **„Sync"**-Button ruft dann nur `syncBranch` erneut auf → derselbe
Konflikt → erneute Eskalation. Es gibt keinen Weg, den Konflikt aus mads heraus zu lösen.

**Lösung.** Bei einem Sub mit `merge_conflict`-Eskalation einen geführten Button
**„Konflikt lösen"** anbieten, der die Auflösung an den Sub-Agenten delegiert
(via `sendInput`, analog zu `commitAgent` in `src/store.ts`):

> „Dein Branch hat einen Rebase-Konflikt mit origin/main. Rebase deinen Branch auf
> origin/main, löse die Konflikte (Duplikate von bereits gemergtem Code verwerfen),
> committe das Ergebnis. NUR rebasen+committen — nicht pushen, keinen PR."

Dies ist eine bewusste Ausnahme zur git-Disziplin-Regel im `systemPrompt`
(`sidecar/src/session.ts`: „kein rebase/push selbst") — eine *gezielte, vom Nutzer
ausgelöste* Konfliktauflösung. Nach Erfolg: `autoSyncConflicted` für den Agenten räumen
(passiert bereits in `handleSync`) bzw. den nächsten Sync/Integrieren-Schritt freigeben.

**Orte:** `src/derive.ts` (`nextStep`: bei Konflikt-Eskalation einen `kind: "resolve"`
zurückgeben), `src/store.ts` (neue Action `resolveConflict(id)`), `src/components/Inspector.tsx`
(Button), ggf. ein Feld am `AgentVM`, das die offene `merge_conflict`-Eskalation spiegelt
(aktuell nur im Sidecar via `autoSyncConflicted` + in `escalations`).

## 2. „Erledigt"-Archiv nur für wirklich fertige Subs

**Problem.** Subs werden in der Sidebar-Gruppe „Erledigt" archiviert und aus dem
aktiven Grid genommen, sobald `pr?.state === "MERGED"` (siehe `src/components/Sidebar.tsx`
und `src/components/AgentGrid.tsx`). Ein Sub kann aber nach dem gemergten PR **weiter
committen** (neue, noch nicht integrierte Arbeit). Solche Subs verschwinden dann
fälschlich ins Archiv, obwohl sie noch Handlung brauchen (Beispiel aus der Session:
`3g`/`erst-messen` waren „jetzt integrierbar", lagen aber unter „Erledigt").

**Lösung.** Nur **wirklich fertige** Subs archivieren. Ein neuer, handlungspflichtiger
Zustand „PR gemergt, aber Branch hat neue Commits" bleibt im aktiven Grid und bekommt in
`nextStep` einen passenden Schritt (neue Arbeit als PR/Integrieren).

**Caveat (wichtig).** Nach einem **Squash-Merge** sind die einzelnen Branch-Commits NICHT
wörtlich in `main` → `git rev-list origin/main..branch` (`ahead`) ist >0, obwohl alles
gemergt ist. `ahead === 0` ist daher KEIN verlässliches „fertig"-Signal. Bessere Signale:
- Sub gilt als fertig, wenn sein **Worktree entfernt** wurde (Integrate-Cleanup räumt ihn),
  bzw. nach erfolgreichem `handleIntegrate`.
- Oder „neue Commits seit Merge" über `git cherry origin/main HEAD` (zeigt mit `+` nur
  Commits, deren patch-id NICHT in main ist) erkennen — robuster gegen Squash.

**Orte:** `src/components/Sidebar.tsx` (Aufteilung `subs`/`doneSubs`), `src/components/AgentGrid.tsx`
(Filter), `src/derive.ts` (`nextStep` für den neuen Zustand). Ggf. ein gepolltes Feld
(z. B. `commitsSinceMerge`) vom Sidecar (`gitStatus`/`prStatus` in `sidecar/src/git.ts`).

## 3. Typecheck-Strenge zwischen den Schichten angleichen

Erhoben 2026-09-02. `strict: true` ist bereits in **beiden** echten Schichten gesetzt
(`tsconfig.json` für Frontend + `shared`, `sidecar/tsconfig.json`) — hier geht es nur noch um
die Lücken *darüber hinaus*. Alle Zahlen unten sind gemessen, nicht geschätzt
(`npx tsc --noEmit -p <config> --<flag>`).

**3a. Dem Sidecar fehlen drei Flags, die die Root-Config hat.** `noUnusedLocals`,
`noUnusedParameters`, `noFallthroughCasesInSwitch` stehen nur in `tsconfig.json`. Damit ist der
Sidecar — die Schicht, die Child-Prozesse und Secrets besitzt — *lockerer* geprüft als das UI.
Kosten des Angleichens: **2 Fehler**, beide toter Import:

```
sidecar/src/accounts.ts(18,10)      'existsSync' ungenutzt
sidecar/src/orchestrator.ts(20,60)  'runManifestPath' ungenutzt
```

Das ist der klare erste Schritt: zwei Zeilen entfernen, drei Flags in `sidecar/tsconfig.json`
nachziehen, und beide Schichten sind gleich streng.

**3b. Test-Dateien laufen ohne Typecheck.** `tsconfig.json` schliesst sie per `exclude` aus
(`shared/**/*.test.ts`, `src/**/*.test.ts`, dito `.tsx`). Der Sidecar prüft seine Tests dagegen mit
(`include: src/**/*.ts`). Das `exclude` einfach zu streichen genügt **nicht** — es entstehen
3 Fehler, alle derselbe Grund: die Tests laufen unter Node, die Root-Config kennt aber nur
DOM-Typen.

```
shared/adr.test.ts(68,3)            Cannot find name 'process'
shared/commit-hygiene.test.ts(44,3) Cannot find name 'process'
src/cmLivePreview.test.ts(90,3)     Cannot find name 'process'
```

Sauber ist eine eigene `tsconfig.test.json`, die die Test-Dateien einschliesst und
`"types": ["node"]` setzt, plus ein `typecheck:test`-Script. Eigener, kleiner Schritt.

**3c. `tsconfig.node.json` hat kein `strict`.** Betrifft nur `vite.config.ts` — kosmetisch,
aber ohne Grund inkonsistent.

**3d. Strenger als `strict` — bewusst als eigenes Vorhaben, nicht nebenbei.** Gemessener Umfang:

| Flag | Frontend/shared | Sidecar |
|---|---|---|
| `noImplicitOverride` | 3 | 0 |
| `exactOptionalPropertyTypes` | 66 | 57 |
| `noUncheckedIndexedAccess` | 95 | 92 |

`noImplicitOverride` ist praktisch geschenkt und kann mit 3a mitlaufen. Die anderen beiden sind
je ~120–190 Fundstellen und gehören schichtweise angegangen. Von beiden ist
`noUncheckedIndexedAccess` der einzige, der real Bugs findet (jeder Array-Index wird
`T | undefined`) — und passt zum Muster, das im Code ohnehin schon üblich ist
(`const [sha = "", name = ""] = out.split("\t")`). `exactOptionalPropertyTypes` ist dagegen
überwiegend Umschreibarbeit an `?:`-Feldern; Nutzen/Aufwand deutlich schlechter.
