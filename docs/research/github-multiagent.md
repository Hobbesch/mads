# GitHub-Multi-Agent-Orchestrierung & gh-Best-Practices für mads

> **Kontext.** Dieses Dokument übersetzt den bewährten Integrator/Worktree/Stale-Base-Leitfaden
> aus `_paix-multi-agent-reference.md` in die **mads-Mechanik**: eine native macOS-App
> (Tauri 2 + React/TS) mit einem **Node-Sidecar**, der das offizielle Claude Agent SDK fährt
> und mehrere Claude-Code-Agenten (Main/Integrator + Sub 1..N) auf je eigener Branch in
> eigenem Worktree orchestriert. Es **widerspricht der paix-Referenz nicht**, sondern macht
> ihre Invarianten programmatisch ausführbar und ergänzt: *Wie nutzt mads GitHub voll aus?*
>
> Die paix-Invarianten gelten unverändert weiter:
> 1. **Only `main` merges** — kein Sub-Stream landet je selbst auf `main`.
> 2. **`main` is always runnable** — jeder Merge passiert grünes, deterministisches CI.
> 3. **Subs never self-merge** — außen-sichtbare Aktionen brauchen explizite Anweisung.
>
> Stand: 2026-06-19. Bevorzugte Versionen: `gh` 2.94/2.95, Octokit `octokit.js` (REST+GraphQL),
> GitHub GraphQL API v4.

---

## 0. TL;DR für mads-Implementierer

- **Aus dem Node-Sidecar:** `gh` CLI als **primären** Pfad für mutierende/auth-tragende
  Aktionen (PR create/merge, run watch), **Octokit GraphQL** für effizientes
  Status-**Polling** (ein Query liefert mergeable + mergeStateStatus + reviewDecision +
  Checks für *alle* PRs auf einmal). Git-Operationen (fetch/rebase/push) immer als nativer
  `git`-Childprozess pro Worktree.
- **Eskalation = Dashboard-Alarm.** mads pollt vier GraphQL-Signale pro Sub-Agent und zeigt
  „braucht Hilfe", sobald eines feuert: `mergeStateStatus ∈ {DIRTY, BEHIND, BLOCKED}`,
  `reviewDecision = CHANGES_REQUESTED/REVIEW_REQUIRED`, CI-`conclusion = FAILURE`, oder ein
  `git push`-Reject (non-fast-forward).
- **Auth:** `gh auth login --secure-storage` (macOS Keychain) ist der Default; der Sidecar
  erbt das Token via `gh auth token`. Für unbeaufsichtigten Mehr-Repo-Betrieb optional
  GitHub App. Scopes: `repo, workflow, read:org`.
- **Defaults wie paix:** `git config --global rerere.enabled true`, frozen-lockfile-CI,
  Squash-Merge mit `--delete-branch`, Branch-Protection auf `main` (PR-only + required
  checks + 1 Review). Merge-Queue erst ab ≥2 racing PRs/h.

---

## 1. Wie mads programmatisch GitHub nutzt: gh CLI vs REST/GraphQL vs Octokit

mads hat **keinen öffentlichen Endpoint** (Desktop-App) und einen **Node-Sidecar** als
einzigen Ort für Netz-/Prozess-IO. Drei Zugangswege, die sich kombinieren lassen:

| Weg | Wofür in mads | Vorteile | Nachteile |
| --- | --- | --- | --- |
| **`gh` CLI** (Childprozess via `execa`/`spawn`) | Mutationen mit Auth: `gh pr create/merge`, `gh run watch`, `gh pr checks --watch`. Auch `gh api graphql` als dünner Wrapper. | Auth „kostenlos" (Keychain-Token), kennt Repo-Kontext, stabile JSON-Ausgabe (`--json`), eigene sinnvolle Exit-Codes. | Prozess-Spawn-Overhead; Output-Parsing; Repo-Kontext nötig (cwd = Worktree) für `gh pr *` ohne `-R`. |
| **Octokit GraphQL** (`@octokit/graphql` / `octokit`) | **Polling** des Dashboards: ein Batch-Query über alle offenen PRs → mergeable/mergeStateStatus/reviewDecision/Checks. | Ein Roundtrip für N PRs; ETag-Caching & Throttling-Plugins; voller Zugriff auf Felder, die `gh` nicht exponiert (z. B. cross-repo). | Eigene Auth-Verdrahtung; GraphQL-Punkte-Budget (5.000 pts/h). |
| **Octokit REST** (`octokit`) | Punktuelle Reads mit **conditional requests** (ETag → 304 zählt nicht), Ruleset-/Branch-Protection-Setup. | 304 spart Rate-Limit; einfache Endpoints. | Mehr Roundtrips als GraphQL; manche Merge-Detail-Felder nur in GraphQL. |

**Empfehlung für den Node-Sidecar:**

1. **Mutationen → `gh`.** Die App hat ohnehin einen authentifizierten `gh` (s. §7). Ein
   `gh`-Wrapper-Modul kapselt `pr create`, `pr merge`, `run watch` und liefert Exit-Code +
   geparstes JSON zurück. Das vermeidet doppelte Auth-Logik und nutzt die durchdachten
   `gh`-Exit-Codes (§4).
2. **Status-Polling → Octokit GraphQL.** Ein einziger periodischer Query (alle 15–30 s, mit
   Backoff) deckt das ganze Dashboard ab. GraphQL ist hier deutlich günstiger als N×REST.
3. **Setup/Selten → Octokit REST** (Rulesets) bzw. `gh api`.

> **Hybrid in der Praxis:** `gh api graphql -f query='…'` gibt dir GraphQL **ohne**
> separaten Octokit-Auth-Pfad — guter Mittelweg, solange der Polling-Durchsatz moderat
> ist. Sobald du ETag-/Throttling-Feinsteuerung willst, lohnt sich nativer Octokit.

```ts
// Sidecar: gh als Childprozess (Mutation), Worktree als cwd
import { execa } from "execa";

async function createPr(worktreeDir: string, head: string) {
  const { stdout } = await execa(
    "gh",
    ["pr", "create", "--base", "main", "--head", head, "--fill", "--json", "url,number"],
    { cwd: worktreeDir }
  );
  return JSON.parse(stdout) as { url: string; number: number };
}
```

```ts
// Sidecar: Octokit GraphQL fürs Dashboard-Polling (ein Query, alle PRs)
import { graphql } from "@octokit/graphql";
const gql = graphql.defaults({ headers: { authorization: `token ${await ghToken()}` } });

const data = await gql(`
  query($owner:String!, $repo:String!) {
    repository(owner:$owner, name:$repo) {
      pullRequests(states: OPEN, first: 50) {
        nodes {
          number headRefName isDraft
          mergeable                 # CONFLICTING | MERGEABLE | UNKNOWN
          mergeStateStatus          # BEHIND|BLOCKED|CLEAN|DIRTY|DRAFT|HAS_HOOKS|UNKNOWN|UNSTABLE
          reviewDecision            # APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null
          commits(last:1){ nodes{ commit{
            statusCheckRollup{ state }   # SUCCESS|FAILURE|PENDING|ERROR|EXPECTED
          } } }
        }
      }
    }
  }`, { owner, repo });
```

---

## 2. Branch-Protection auf `main`, CODEOWNERS, Merge-Queue

Setzt die paix-Setup-Checkliste (Zeile 421: „PR-only, required green CI, required review")
mechanisch um. **Rulesets** (das neuere System) sind gegenüber Classic Branch Protection zu
bevorzugen — sie sind per REST-API verwaltbar und versionierbar als JSON-Artefakt (passt zur
paix-Regel „Koordination über committete Artefakte").

### 2.1 Branch-Protection / Ruleset auf `main`

Minimal-Set für mads:

- **PR-only:** Direkt-Pushes auf `main` blockieren (`deletion`/`non_fast_forward` +
  `pull_request`-Regel). → erzwingt Invariante „Only `main` merges via PR".
- **Required status checks:** die deterministischen CI-Jobs (lint, type-check, test). Mit
  `strict: true` („branch must be up to date") wird ein **BEHIND**-PR mechanisch geblockt —
  genau das stale-base-Gate aus paix.
- **Required review:** ≥1 Approval. → der Integrator/Mensch ist das Gate.
- **CODEOWNERS:** optional, aber für mads stark — kodiert die paix-Ownership-Map (§6 der
  Referenz) mechanisch: überlappende Datei-Listen werden als Required-Reviewer sichtbar.

```jsonc
// Ruleset (REST: PUT /repos/{owner}/{repo}/rulesets) — Auszug
{
  "name": "protect-main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/main"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request",
      "parameters": { "required_approving_review_count": 1,
                      "require_code_owner_review": true,
                      "dismiss_stale_reviews_on_push": true } },
    { "type": "required_status_checks",
      "parameters": { "strict_required_status_checks_policy": true,
                      "required_status_checks": [
                        { "context": "lint" }, { "context": "type-check" }, { "context": "test" } ] } }
  ]
}
```

> **CODEOWNERS-Datei** (`.github/CODEOWNERS`): pro Modul/Seam einen Owner; geteilte
> Seam-Dateien (lockfile, zentrale Registry, i18n) bekommen einen einzigen Owner — das ist
> die mechanische Form von paix-„Option B: genau EIN Owner-Branch". `require_code_owner_review`
> erzwingt dann, dass ein PR, der eine geteilte Datei berührt, den Owner als Reviewer zieht.

### 2.2 Merge-Queue (GitHub native)

**Wann:** paix sagt — erst ab **≥2 racing PRs/Stunde** lohnt die Queue; für einen
Solo-Integrator mit <2 ist „rebase-onto-fresh-main + CI-re-run" 90 % des Nutzens (Referenz
§7). Für mads gilt das gleiche, mit einer Nuance: weil mads **viele Sub-Agenten parallel**
fahren kann, kann der racing-PR-Druck schnell steigen → Queue dann sinnvoll.

**Was die Queue löst:** Sie testet den **would-be-merged**-Zustand (latestes `main` + alle
PRs davor in der Queue) statt „grün auf meiner Branch". Das ist exakt die paix-Serialisierung
(§7), nur automatisiert.

**Kritischer CI-Gotcha:** Required Checks müssen auf **`merge_group`** laufen, nicht nur auf
`pull_request` — sonst stallt die Queue mit „missing checks":

```yaml
on:
  pull_request:
    branches: [main]
  merge_group:
    types: [checks_requested]   # Queue erzeugt temporäre queue-Branches und testet kombiniert
```

**Konfiguration:** Merge-Queue lebt heute in Rulesets/Branch-Protection. Die **REST-API
unterstützt die Merge-Queue-Regel (Stand 2026) noch nicht vollständig** — verlässlich ist
das Aktivieren via **GraphQL** (`updateRepositoryRuleset` / `createMergeQueue`-Pfad) bzw. die
UI. mads sollte das als **einmaligen Setup-Schritt** behandeln und das gewünschte Ruleset-JSON
versioniert ablegen (apply via `gh api`/Octokit beim Platform-Setup). *(UNVERIFIZIERT im
Detail: exakter GraphQL-Mutationsname für Merge-Queue — bei Implementierung gegen das aktuelle
GraphQL-Schema prüfen.)*

---

## 3. PR-Lebenszyklus programmatisch

Bildet den paix-Lebenszyklus (Referenz §5) auf konkrete Sidecar-Aufrufe ab.

### 3.1 Erstellen

```bash
git push -u origin feat/<task>                     # erster Push: plain (nichts zu forcen)
gh pr create --base main --head feat/<task> --fill --json url,number
```

`gh pr create`-Flags, die mads nutzt: `--fill` (Titel/Body aus Commits), `--fill-first`,
`--draft` (Sub-Agent noch nicht fertig → Draft hält die Queue/Required-Review-Logik fern),
`--reviewer <handle|team>`, `--head` (skippt Auto-Fork/Push), `--label`.

### 3.2 Status/Checks pollen

Drei Werkzeuge, je nach Zweck:

| Zweck | Befehl | Hinweis |
| --- | --- | --- |
| Blockierend auf Abschluss warten | `gh pr checks <pr> --watch --interval 30 [--fail-fast]` | gut für „Sub-Agent wartet auf eigenes CI". `--required` = nur required Checks. |
| Workflow-Run live verfolgen | `gh run watch <run-id> [--exit-status]` | `--exit-status` → nonzero, wenn der Run fehlschlägt. |
| Snapshot ohne Watch | `gh pr checks <pr> --json name,state,bucket,link` | für periodisches Dashboard-Polling. |
| Run-Liste | `gh run list --json databaseId,status,conclusion,headBranch,workflowName` | `conclusion ∈ success/failure/cancelled/...`; `status ∈ queued/in_progress/completed`. |

**Wichtig (Automation):** `gh pr checks` hat **eigene Exit-Codes**:

- `0` = alle Checks **passed**
- `1` = mind. ein Check **failed**
- `8` = Checks **pending** (laufen noch)

So kann mads „rot" (1 → Eskalation) von „läuft noch" (8 → weiter pollen) unterscheiden, ohne
Output zu parsen. (Caveat: bei „keine Checks vorhanden" liefert `gh pr checks` historisch
nonzero — siehe cli/cli #9390/#9682; für mads: erst `statusCheckRollup == null` prüfen.)

Für das **Dashboard** ist GraphQL-`statusCheckRollup.state` günstiger (ein Query, alle PRs)
als N× `gh pr checks`.

### 3.3 Reviews

```bash
gh pr review <pr> --approve | --request-changes -b "…" | --comment -b "…"
gh pr view <pr> --json reviewDecision,reviews,latestReviews
```

`reviewDecision` ist das maßgebliche Aggregat: `APPROVED | CHANGES_REQUESTED |
REVIEW_REQUIRED | null` (null = keine Review-Regel aktiv).

### 3.4 Merge (nur der Integrator)

```bash
gh pr merge <pr> --squash --delete-branch [--auto] [--match-head-commit <SHA>]
```

mads-Defaults (= paix §7): **`--squash`** (lineare `main`, jeder Commit unabhängig
lauffähig, gut für `git bisect`) + **`--delete-branch`** (Cleanup). Weitere Flags:

- `--auto` — merged **automatisch, sobald** Required-Checks+Review grün sind. Stark in
  Kombination mit Branch-Protection: der Integrator „verfügt" einmal, GitHub landet erst bei
  erfüllten Gates. Erfordert aktivierte Auto-Merge im Repo.
- `--match-head-commit <SHA>` — merged **nur**, wenn der PR-Head noch der erwartete SHA ist
  (Schutz gegen „inzwischen weitergeschoben"; das PR-Pendant zu `--force-with-lease`).
- `--admin` — Gates **umgehen**. In mads **default verboten**; widerspräche „main always
  runnable". Nur als explizite, geloggte Mensch-Aktion.

### 3.5 Konflikt-Erkennung (mergeable / mergeStateStatus)

Der Kern für „braucht Hilfe". Aus GraphQL (`pullRequest`):

| Feld | Werte | Bedeutung (offizielle Beschreibung) |
| --- | --- | --- |
| `mergeable` | `CONFLICTING` | „The pull request cannot be merged due to merge conflicts." → **Eskalation** |
| | `MERGEABLE` | „The pull request can be merged." |
| | `UNKNOWN` | „The mergeability … is still being calculated." → erneut pollen |
| `mergeStateStatus` | `BEHIND` | „The head ref is out of date." → **stale base** → rebase nötig |
| | `BLOCKED` | „The merge is blocked." → Required Review/Check fehlt → **Eskalation/Gate** |
| | `CLEAN` | „Mergeable and passing commit status." → grün |
| | `DIRTY` | „The merge commit cannot be cleanly created." → **Merge-Konflikt** |
| | `DRAFT` | „The merge is blocked due to the pull request being a draft." |
| | `HAS_HOOKS` | „Mergeable with passing commit status and pre-receive hooks." |
| | `UNKNOWN` | „The state cannot currently be determined." → erneut pollen |
| | `UNSTABLE` | „Mergeable with non-passing commit status." → CI rot/pending, aber nicht required-blockend |

> **mergeable wird lazy berechnet.** GitHub kalkuliert `mergeable`/`mergeStateStatus` erst,
> wenn jemand sie abfragt; der erste Abruf liefert oft `UNKNOWN`. mads-Strategie: bei
> `UNKNOWN` einen kurzen Re-Poll (1–3 s später) einplanen, dann den Wert verwenden.

---

## 4. Automatische Eskalations-Erkennung ("Sub-Agent braucht Hilfe")

Das ist der zentrale mads-Mehrwert gegenüber paix: paix beschreibt die *Regeln*, mads soll
sie *automatisch erkennen*. Jedes Signal unten ist deterministisch aus `git`-Exit-Codes oder
GraphQL/`gh`-Feldern ableitbar.

| Eskalations-Trigger | Konkretes Signal | Quelle / Abfrage |
| --- | --- | --- |
| **CI rot** | `statusCheckRollup.state == FAILURE \|\| ERROR`; oder `gh pr checks` Exit `1`; oder `gh run watch --exit-status` nonzero; oder `conclusion == failure` | GraphQL `commits(last:1).…statusCheckRollup`; `gh pr checks`; `gh run list --json conclusion` |
| **Merge-Konflikt** | `mergeable == CONFLICTING` **oder** `mergeStateStatus == DIRTY` | GraphQL `pullRequest.mergeable / mergeStateStatus` |
| **Stale base** (Branch hinter `main`) | `mergeStateStatus == BEHIND` (bei `strict` Required-Checks); **oder** lokal `git rev-list --count origin/main ^HEAD > 0` | GraphQL; bzw. `git` im Worktree |
| **Push rejected (non-fast-forward)** | `git push` Exit ≠ 0 + stderr enthält `! [rejected]` / `non-fast-forward` / `fetch first` | `git push`-Childprozess-Exit + stderr-Match |
| **Required Review fehlt** | `reviewDecision == REVIEW_REQUIRED \|\| CHANGES_REQUESTED` | GraphQL `pullRequest.reviewDecision` |
| **Branch-Protection-Block** | `mergeStateStatus == BLOCKED`; **oder** `gh pr merge` schlägt mit Protection-Fehler fehl | GraphQL; bzw. `gh pr merge` stderr/Exit |
| **Auth/Setup kaputt** | `gh` Exit `4` (auth required) | `gh`-Exit-Code |

**gh-Exit-Code-Konvention** (für robuste Sidecar-Logik): `0` Erfolg, `1` generischer Fehler,
`2` abgebrochen, `4` Auth nötig; einzelne Befehle definieren mehr (`gh pr checks`: `8`
pending). → mads sollte **erst auf Exit-Codes** verzweigen, dann JSON parsen.

### 4.1 Ein GraphQL-Query, der alle Dashboard-Signale liefert

```graphql
query($owner:String!, $repo:String!) {
  repository(owner:$owner, name:$repo) {
    pullRequests(states: OPEN, first: 50) {
      nodes {
        number title headRefName isDraft
        mergeable                                  # CONFLICTING => Konflikt
        mergeStateStatus                           # DIRTY/BEHIND/BLOCKED => Eskalation/Gate
        reviewDecision                             # CHANGES_REQUESTED/REVIEW_REQUIRED => Review-Gate
        commits(last: 1) { nodes { commit {
          statusCheckRollup { state }              # FAILURE/ERROR => CI rot
        } } }
      }
    }
  }
}
```

mads mappt die Knoten 1:1 auf Sub-Agent-Kacheln; eine reine Funktion
`classify(node) -> "ok" | "needs_help" | "waiting"` zentralisiert die Logik.

### 4.2 Lokale Git-Signale pro Worktree (ergänzend, ohne API-Kosten)

```bash
# stale base: wie weit ist die Branch hinter origin/main?
git fetch origin
git rev-list --left-right --count origin/main...HEAD   # "behind\tahead"

# Push-Reject sauber abfangen (Exit-Code + stderr-Match):
git push --force-with-lease 2>&1; echo "exit=$?"
# stderr-Marker: "! [rejected]", "non-fast-forward", "stale info", "fetch first"

# Lokale Konflikt-Prüfung vor PR (Trockenlauf-Rebase im Worktree):
git rebase origin/main || git rebase --abort   # nicht-null + CONFLICT-Marker => stale-base-Konflikt
```

---

## 5. Webhooks vs Polling — die Desktop-Realität

mads hat **keinen öffentlichen Endpoint** → klassische Webhooks (GitHub POSTet an eine URL)
sind **nicht** direkt nutzbar. Optionen:

| Ansatz | Eignung für mads | Bewertung |
| --- | --- | --- |
| **Polling (GraphQL, batched)** | Standardweg | **Empfohlen.** Ein Query alle 15–30 s deckt alle PRs ab. |
| **REST conditional requests (ETag → 304)** | Ergänzend | 304 **zählt nicht** gegen das primäre Rate-Limit → sehr günstig fürs Polling. |
| **`gh pr checks --watch` / `gh run watch`** | Pro Sub-Agent, kurzlebig | Gut, wenn ein Agent gezielt auf *sein* CI wartet (server-seitiges Long-Poll). Nicht für N PRs parallel. |
| **Webhook + Relay** (GitHub App → Hosted Relay → SSE/WS in App) | Nur bei echtem Live-Bedarf | Braucht eigenen Server → Komplexität/Hosting. Für mads i. d. R. Overkill. |

### 5.1 Polling-Strategie (Raten + Backoff)

- **Rate-Limit-Budget:** `gh`/OAuth-Token = **5.000 GraphQL-Punkte/Stunde** (primär). Ein
  Dashboard-Query über ~50 PRs kostet grob ~10–30 Punkte → bei 30-s-Intervall ≈ 120
  Queries/h ⇒ ~1.2k–3.6k Punkte/h. Passt, aber nicht beliebig parallelisierbar.
  *(Hinweis: Es gibt 2026 Diskussionen, `gh`-OAuth-Token auf 12.500 pts/h anzuheben — bis
  bestätigt: mit 5.000 rechnen. UNVERIFIZIERT.)*
- **Adaptives Intervall:** schnelles Polling (10–15 s) nur, solange ein PR im aktiven
  Zustand ist (CI läuft / gerade gepusht); idle-PRs auf 60–120 s drosseln.
- **Exponentielles Backoff** bei `403`/`429`/secondary-rate-limit: `Retry-After`-Header
  respektieren; Octokit `plugin-throttling` (`onRateLimit`/`onSecondaryRateLimit`) +
  `plugin-retry` erledigen das deklarativ.
- **ETag-Caching** für REST-Reads: `If-None-Match` → 304 ohne Rate-Limit-Kosten.
  Caveat: ETag ist token-gebunden — bei GitHub App rotiert das Installation-Token stündlich
  und invalidiert den Cache.
- **Jitter:** Polling der N Sub-Agenten nicht synchron feuern; Start-Offsets verteilen.

```ts
import { Octokit } from "octokit";          // bündelt REST+GraphQL+throttling+retry
const octokit = new Octokit({
  auth: await ghToken(),
  throttle: {
    onRateLimit: (retryAfter, opts, o, retryCount) => retryCount < 3,        // bis 3x retry
    onSecondaryRateLimit: (retryAfter) => true,                              // immer warten
  },
});
```

---

## 6. Worktree-Lifecycle als ausführbare mads-Operationen

Direkt aus paix §4/§5/§7 abgeleitet, als sechs idempotente Sidecar-Operationen, die der
Orchestrator (Main-Agent) oder das mads-UI auslösen kann. Jede Operation = Git-/`gh`-Aufruf +
Signal-Auswertung → Statusrückgabe ans Dashboard.

### `create(task, base="origin/main")`
```bash
git fetch origin
git worktree add -b feat/<task> <WT_DIR>/<task> origin/main
# macOS-Hinweis: WT_DIR außerhalb des Repos (z. B. ~/mads-worktrees), damit git ihn nicht
# in der Working-Tree-Suche sieht. node_modules/.venv pro Worktree (kein blindes Symlinken,
# wenn ein Worktree das Lockfile ändert — paix-Disziplin).
```
→ Dashboard: neue Sub-Agent-Kachel, Status „working".

### `sync(task)` (der stale-base-Killer, ≥1×/Tag, mehr wenn `main` heiß)
```bash
git -C <WT_DIR>/<task> fetch origin
git -C <WT_DIR>/<task> rebase origin/main          # rerere replayt Wiederholer
# bei Konflikt: nicht-null Exit + CONFLICT-Marker => Status "needs_help: rebase conflict"
git -C <WT_DIR>/<task> push --force-with-lease      # NUR wenn schon gepusht; Reject => Eskalation
```
→ Dashboard: „behind N / ahead M" Badge; bei Rebase-Konflikt Eskalation.

### `gate(task)` (Quality Gates lokal, auf NEUER Basis, frozen install)
```bash
# frozen lockfile (mads-Stack JS/TS):
npm ci          # bzw. pnpm install --frozen-lockfile / yarn install --frozen-lockfile
npm run lint && npm run typecheck && npm test
# Node-Sidecar separat: cd sidecar && npm ci && npm test
# Tauri-Rust-Anteil: cargo test (Cargo.lock committet => deterministisch)
```
→ Dashboard: lokales Gate grün/rot, **bevor** ein PR Rate-Limit/CI kostet.

### `pr(task)` (main = einziges Merge-Ziel)
```bash
git -C <WT_DIR>/<task> push -u origin feat/<task>
gh pr create -R <owner>/<repo> --base main --head feat/<task> --fill --json url,number
```
→ Dashboard: PR-Link + Poll-Start (§4.1).

### `integrate(task)` (NUR Integrator/Main-Agent; serialisieren, nie parallel)
```text
1. PR wählen (Reihenfolge: geteilter/fundamentaler Code zuerst — paix §7).
2. Vor-Merge-Check (GraphQL): mergeStateStatus muss CLEAN/HAS_HOOKS sein,
   reviewDecision == APPROVED, statusCheckRollup == SUCCESS.
   Sonst -> zurück an Sub-Agent (sync + gate).
3. gh pr merge <pr> --squash --delete-branch [--match-head-commit <SHA>]
4. main rückt vor -> nächsten PR onto NEUES main rebasen (sync) -> wiederholen.
```
→ Optional `--auto` statt manueller Schleife, wenn Branch-Protection alle Gates erzwingt.

### `cleanup(task)`
```bash
git worktree remove <WT_DIR>/<task>      # refuse bei dirty; -f erzwingt
git branch -d feat/<task>                # safe: nur wenn merged
git worktree prune
git push origin --delete feat/<task>     # falls --delete-branch nicht gegriffen hat
```
→ Dashboard: Kachel entfernen.

> **Diese sechs Ops sind die mechanische Übersetzung der paix-Schnellreferenz (Zeilen
> 417–464).** Der Orchestrator komponiert sie; die Eskalations-Signale aus §4 entscheiden,
> wann `sync`/`gate` wiederholt werden müssen, bevor `integrate` zulässig ist.

---

## 7. Auth aus einer Desktop-App

| Methode | Eignung für mads | Scopes / Hinweise |
| --- | --- | --- |
| **`gh auth login` (Keychain)** | **Default-Empfehlung.** | `gh` speichert das OAuth-Token seit Default-`--secure-storage` im macOS-**Keychain**. Sidecar holt es via `gh auth token`. Scopes via `gh auth refresh -s …`. |
| **Fine-grained PAT** | Wenn ohne `gh`-Login gewünscht | User legt Token an; mads liest aus Keychain (Tauri `keyring`/`Stronghold`), nie aus Klartext/Repo. Repo-scoped + minimale Permissions. |
| **Classic PAT** | Legacy | Scopes `repo, workflow, read:org`; gröber als fine-grained → nur wenn nötig. |
| **GitHub App** | Mehr-Repo / unbeaufsichtigt / Org-Betrieb | Installation-Token (stündliche Rotation). Höhere Rate-Limits möglich; aber: ETag-Cache invalidiert bei Token-Rotation (§5.1). Mehr Setup. |

**Benötigte Scopes** (klassisch): `repo` (PRs, Status, private Repos), `workflow`
(Actions/CI verändern, z. B. Re-run), `read:org` (Team-Reviewer, CODEOWNERS-Teams).
Fine-grained Äquivalent: *Pull requests: RW, Contents: RW, Checks: read, Workflows: RW,
Members: read*.

**Sicherheits-Hinweise für mads:**
- **Token nie in Repo/Logs/Klartext.** Keychain (gh) bzw. Tauri-Secure-Storage. Sidecar-IPC
  nicht das Token loggen.
- **`gh` kann auf insecure file-storage zurückfallen**, wenn kein Keyring verfügbar ist
  (cli/cli #10108/#7757). mads sollte explizit prüfen, dass Secure-Storage aktiv ist.
- **Least privilege:** lieber fine-grained PAT/GitHub App mit repo-scope als classic-`repo`.
- **`--admin`-Merge** als auditierte Ausnahme behandeln (§3.4).
- Bei GitHub App: private Key sicher verwahren; Installation-Token nicht persistieren.

---

## 8. mads-Defaults (aus paix, programmatisch verankert)

| Default | Einmal-Setup | Warum (paix-Bezug) |
| --- | --- | --- |
| **`git rerere`** | `git config --global rerere.enabled true` (im Repo: `--local`) | Replayt Wiederhol-Konflikte beim wiederholten Rebase aufs bewegliche `main` (Referenz §9). mads kann es beim ersten Worktree-`create` setzen. |
| **Frozen-lockfile-CI** | CI nutzt `npm ci` / `pnpm --frozen-lockfile` / `yarn --frozen-lockfile`; Rust `Cargo.lock` committet | Schließt die „grün-auf-Branch ≠ grün-auf-main"-Lücke (Referenz §9). **Voraussetzung dafür, dass der Vor-Merge-Check in §6 verlässlich ist.** |
| **Squash-Merge + `--delete-branch`** | `gh pr merge --squash --delete-branch` als mads-Default | Lineare `main`, jeder Commit lauffähig, automatischer Cleanup (Referenz §7). |
| **Branch-Protection/Ruleset** | §2 Ruleset auf `main` | PR-only + required checks + 1 Review = die drei Invarianten mechanisch (Referenz §2). |
| **`--force-with-lease`** statt `--force` | im `sync` (§6) | Bricht ab, wenn das Remote unerwartet wanderte (Referenz §10). |

> **mads-spezifischer CI-Hinweis (Tauri + Node-Sidecar):** zwei Lockfile-Achsen —
> JS/TS (`package-lock.json`/`pnpm-lock.yaml`) **und** Rust (`Cargo.lock`). Beide committen,
> beide frozen installieren. Ändern zwei Sub-Branches dasselbe Lockfile → das ist ein
> **geteilter Datei-Edit** und folgt dem paix-Shared-File-Protokoll (land-first oder
> single-owner, Referenz §6).

---

## 9. Caveats / offene Punkte für die Doku-Autoren

1. **Die 3–4 Dashboard-Eskalations-Signale (Kern-Caveat):** Das mads-Dashboard muss
   **mindestens** diese vier als „Sub-Agent braucht Hilfe" anzeigen — alle aus **einem**
   GraphQL-Query (§4.1) + einem `git push`-Exit ableitbar:
   - **CI rot** → `statusCheckRollup.state ∈ {FAILURE, ERROR}` (bzw. `gh pr checks` Exit 1).
   - **Merge-Konflikt** → `mergeable == CONFLICTING` **oder** `mergeStateStatus == DIRTY`.
   - **Stale base** → `mergeStateStatus == BEHIND`.
   - **Gate offen** (Review/Protection) → `reviewDecision ∈ {REVIEW_REQUIRED, CHANGES_REQUESTED}`
     **oder** `mergeStateStatus == BLOCKED`; plus der lokale **push-reject** (non-fast-forward).
   `UNKNOWN` (mergeable/mergeStateStatus) ist **kein** Alarm, sondern „lazy noch nicht
   berechnet" → kurzer Re-Poll, sonst false positives.

2. **Merge-Queue-Aktivierung ist (noch) nicht sauber REST-automatisierbar.** Die
   Merge-Queue-Regel wird verlässlich über GraphQL/UI gesetzt, nicht über die REST-Rules-API
   (Stand 2026). Der exakte GraphQL-Mutationsname ist **UNVERIFIZIERT** — vor Implementierung
   gegen das aktuelle GraphQL-Schema prüfen. Außerdem: ohne `on: merge_group` in der
   CI-YAML stallt die Queue („missing checks") — das muss die Doku als harte Voraussetzung
   nennen.

3. **Rate-Limit-Budget begrenzt die Polling-Aggressivität.** `gh`/OAuth-Token = 5.000
   GraphQL-Punkte/h (eine evtl. Anhebung auf 12.500 ist **UNVERIFIZIERT** — konservativ mit
   5.000 planen). Bei vielen parallelen Sub-Agenten muss mads **batched GraphQL** (ein Query
   für alle PRs) + adaptives Intervall + Backoff/Jitter nutzen; naive N× `gh pr view`-Polls
   pro Agent sprengen das Budget. ETag/304 hilft bei REST, ist aber token-gebunden (GitHub
   App → stündliche Token-Rotation invalidiert den Cache).

4. **`gh`-Versions-Drift:** Die in §3 zitierten `gh`-Flags/Exit-Codes (`--match-head-commit`,
   `gh pr checks` Exit 8, `--exit-status` bei `gh run watch`) gegen die im mads-Sidecar
   **gebündelte/gepinnte** `gh`-Version verifizieren; `gh` entwickelt sich pro Release (2.94
   brachte z. B. Issues 2.0 + Discussions, nichts PR-Merge-Relevantes). Empfehlung: `gh`
   nicht nur „im PATH erwarten", sondern Version beim Sidecar-Start prüfen/pinnen.

---

## Quellen

- GitHub CLI Manual — `gh pr create`, `gh pr merge`, `gh pr checks`, `gh run watch`, `gh run list`, `gh auth login`, Exit-Codes: <https://cli.github.com/manual/> (insb. `gh_pr_create`, `gh_pr_merge`, `gh_pr_checks`, `gh_run_watch`, `gh_run_list`, `gh_auth_login`, `gh_help_exit-codes`)
- GitHub CLI 2.94.0 Release Notes: <https://github.com/cli/cli/releases/tag/v2.94.0> ; Releases-Übersicht: <https://github.com/cli/cli/releases>
- cli/cli #7848 (`gh pr checks` Exit-Code PENDING vs FAILED → Exit 8): <https://github.com/cli/cli/issues/7848>
- cli/cli #9390 / #9682 (`gh pr checks` ohne Checks / required): <https://github.com/cli/cli/issues/9390>
- cli/cli #13239 (`gh pr list` hat `mergeStateStatus`/`reviewDecision`, `gh search prs` nicht): <https://github.com/cli/cli/issues/13239>
- cli/cli #13433 (GraphQL Rate-Limit `gh`-OAuth 5.000 → Vorschlag 12.500 pts/h): <https://github.com/cli/cli/issues/13433>
- cli/cli #10108 / #7757 (`gh` Keyring-Fallback auf insecure storage): <https://github.com/cli/cli/issues/10108>
- GitHub GraphQL Enum `MergeStateStatus` (BEHIND/BLOCKED/CLEAN/DIRTY/DRAFT/HAS_HOOKS/UNKNOWN/UNSTABLE) und `Mergeable` (CONFLICTING/MERGEABLE/UNKNOWN): <https://docs.github.com/en/graphql/reference/enums> (Sektion Pulls)
- GitHub REST — Rules/Rulesets: <https://docs.github.com/en/rest/repos/rules>
- GitHub Docs — Managing a merge queue: <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue>
- GitHub Changelog — Repository Rules: configure merge queue rule (beta): <https://github.blog/changelog/2024-02-27-repository-rules-configure-merge-queue-rule-public-beta/>
- Merge-Queue + `merge_group`-CI-Workflow (2026): <https://www.7tech.co.in/github-merge-queue-workflow-rulesets-merge-group-ci/> ; <https://tenki.cloud/blog/github-merge-queue-setup>
- GitHub Docs — Best practices for using the REST API (conditional requests / 304 / Rate-Limits): <https://docs.github.com/rest/guides/best-practices-for-using-the-rest-api>
- Octokit — `octokit.js` (REST+GraphQL SDK für Node): <https://github.com/octokit/octokit.js/> ; `@octokit/plugin-throttling`: <https://github.com/octokit/plugin-throttling.js/> ; `@octokit/core.js`: <https://github.com/octokit/core.js/>
- Conditional HTTP requests + Octokit hooks (ETag-Polling): <https://armel.soro.io/leveraging-conditional-http-requests-and-octokit-hooks-to-avoid-hitting-rate-limits-against-the-github-rest-api/>
- GitHub Docs — Dealing with non-fast-forward errors: <https://docs.github.com/en/get-started/using-git/dealing-with-non-fast-forward-errors>
- PyGithub + Rulesets/Merge-Queue (Referenz für programmatisches Setup): <https://medium.com/@python-javascript-php-html-css/use-rulesets-and-branch-protection-rules-with-pygithub-to-enable-github-merge-queue-266939788215>
- Interne Referenz (Basis dieses Dokuments): `/Users/alessandromedici/Documents/coding/mads/docs/research/_paix-multi-agent-reference.md`
