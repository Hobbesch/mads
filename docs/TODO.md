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
