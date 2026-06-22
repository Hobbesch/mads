# 03 — Main-Agent (der Integrator)

> **Status:** Design, implementierungsreif. Stand 2026-06-19.
> **Stil:** Deutsch (Fließtext), Englisch (Code/Identifier).
> **Scope:** Wie mads den **Main-Agent = Integrator** realisiert — Rolle, technische
> Umsetzung (Hybrid: deterministische Guards im Sidecar + LLM-Agent für Urteilsfragen),
> Merge-/Integrations-Prozedur, Quality-/Security-Gates, periodische Aufgaben,
> Kommunikation mit Sub-Agents, Eskalation an den Menschen, System-Prompt-Skizze.

---

## 0. Zusammenfassung & Einordnung in die Gesamtarchitektur

Der **Main-Agent** ist mads' Operationalisierung der paix-Integrator-Rolle
(`_paix-multi-agent-reference.md` Sektion 2 & 7). Er ist der **einzige** Akteur, der
auf `main` landet, hält `main` immer lauffähig, bestimmt die Integrations-Reihenfolge,
löst mechanische Konflikte, erzwingt Quality-/Security-Gates und gibt Sub-Agents
gezielt Anweisungen.

**Kernempfehlung dieses Dokuments: Hybrid-Architektur.** Der Integrator ist *nicht*
ein einzelner langlaufender LLM-Agent, sondern die Komposition aus zwei Schichten:

1. **Deterministischer Integration-Orchestrator im Node-Sidecar** (`IntegratorEngine`)
   — eine Zustandsmaschine, die die *mechanischen, beweisbaren* Schritte fährt:
   Reihenfolge-Bestimmung, `rebase-onto-fresh-main`, frozen-CI-Re-Run, Vor-Merge-Gate
   (GraphQL-Signale), `gh pr merge --squash`, Cleanup, Cron-Jobs. Diese Schicht *rät
   nie*; sie verweigert lieber und eskaliert.
2. **LLM-Main-Agent als eigene `query()`-Session** (`MAIN_AGENT`, eigener Worktree auf
   `main`) — gerufen nur für **Urteilsfragen**: semantische Konflikt-Klassifikation,
   Security-Review-Synthese, Anweisungstexte an Sub-Agents formulieren,
   Eskalations-Briefings an den Menschen, Reihenfolge-Tie-Breaks bei Mehrdeutigkeit.

Diese Trennung folgt direkt der paix-Invariante „Der Integrator *rät nicht*" (Sektion
7): alles, was beweisbar ist (Exit-Codes, CI-Status, `mergeStateStatus`), gehört in
deterministischen Code; alles, was Domänen-/Sprach-Urteil braucht, an den LLM-Agenten —
und alles, was *weder* mechanisch lösbar *noch* sicher LLM-delegierbar ist, an den
**Menschen** (Sektion 6).

### Die drei paix-Invarianten, die der Main-Agent erzwingt

1. **Only `main` merges.** Kein Sub-Stream landet je selbst auf `main`. Sub-Streams
   *schlagen vor* (PR), der Integrator *verfügt* (Merge). → mechanisch via
   Branch-Protection (`[[sidecar-orchestration]]`/`[[github-multiagent]]`:
   PR-only-Ruleset) **plus** der Sidecar-Regel, dass nur die `IntegratorEngine` das
   Tool `gh pr merge` ausführen darf.
2. **`main` is always runnable.** Jeder Merge passiert grünes, deterministisches CI
   *auf rebase-onto-fresh-main*. Nie rote-CI / stale-base mergen.
3. **Subs never self-merge.** Außen-sichtbare Aktionen (push, merge) brauchen explizite
   Anweisung; Sub-Agents haben `gh pr merge` und Direkt-Push auf `main` per
   `disallowedTools` + Branch-Protection gesperrt.

### Querverweise

| Doc | Bezug zu diesem Dokument |
| --- | --- |
| `[[01-architecture]]` | Gesamttopologie; Main-Agent als eine von N Sessions im Pool. |
| `[[sidecar-orchestration]]` | `AgentSession`-Pool, NDJSON-Protokoll, `canUseTool`, Hooks, Worktree-Lifecycle — die `IntegratorEngine` lebt im selben Sidecar-Prozess. |
| `[[04-sub-agents]]` | Sub-Agent-Lebenszyklus; Gegenstück zur Anweisungs-/Konfliktvermeidungs-Logik hier. |
| `[[02-dashboard]]` | Integrator-Dashboard, Merge-Reihenfolge-Visualisierung, Eskalations-Dialoge. |
| `[[01-architecture]]` | `agents.json`, `OWNERSHIP_MAP`, `BACKLOG`, Persistenz der Integrator-Queue. |
| `[[github-multiagent]]` | gh/Octokit-Wrapper, Ruleset/CODEOWNERS-Setup, GraphQL-Polling, Eskalations-Signale (Quelle für Sektion 4 & 5 hier). |
| `[[claude-code-capabilities]]` | Permission-Modes, Secret-Scan, Protected Paths (Quelle für Sektion 5 hier). |

---

## 1. Rolle & Mandat

### 1.1 Verantwortlichkeiten (paix Sektion 2, Zeile 64)

Der Main-Agent **verwaltet `main`** und ist:

- **Konsolidierer/Merger:** bestimmt Integrations-Reihenfolge, rebaset jede Branch auf
  frisches `main`, lässt CI re-run, merged seriell — nie parallel.
- **Qualitäts-/Sicherheits-Wächter:** erzwingt lint/type/test, ruft den
  `security-reviewer`-Subagent, fährt Secret-Scan + frozen-Lockfile-Check; merged nie
  rote-CI / stale-base.
- **GH-Merge-Überwacher:** pollt `mergeStateStatus`/`reviewDecision`/`statusCheckRollup`
  (`[[github-multiagent]]` §4.1), erkennt Eskalations-Signale, blockt Merges, die
  Gates verletzen.
- **Aufräumer:** periodisch `git worktree prune`, gemergte Branches/Worktrees entfernen,
  stale Branches markieren, `OWNERSHIP_MAP`/`BACKLOG` pflegen.
- **Anweiser:** gibt Sub-Agents über committete Artefakte (ADR/Backlog) und — wo nötig —
  direkte Sidecar-Messages konkrete Anweisungen (rebase jetzt, du besitzt Datei X
  nicht, deine Änderung ist semantisch falsch).

### 1.2 Was der Main-Agent NICHT tut

- Er **schreibt keinen Feature-Code** in Sub-Branches. Sein Worktree ist `main` (read +
  Integrations-Mechanik). Feature-Arbeit gehört den Sub-Agents.
- Er **rät nicht** bei semantischen Konflikten (paix §7) — er schickt zurück an den
  Owner.
- Er nutzt **nie `gh pr merge --admin`** automatisch (Gates umgehen) — das ist eine
  ausschließlich menschliche, geloggte Ausnahme (`[[github-multiagent]]` §3.4).
- Er **mutiert nie** den menschen-besessenen Brief (`CLAUDE.md`/`AGENTS.md`) — er liest
  ihn (paix §8).

### 1.3 Rollen-Matrix (mads-Konkretisierung von paix Zeile 61–65)

| Rolle | mads-Realisierung | Darf | Darf NICHT |
| --- | --- | --- | --- |
| `main` (Linie) | protected Branch, PR-only-Ruleset | — | — |
| **Main-Agent / Integrator** | `IntegratorEngine` (Sidecar) + `MAIN_AGENT` (`query()`-Session, cwd = main-Worktree) | Als Einziger `gh pr merge`; Reihenfolge bestimmen; mechanische Konflikte lösen; Anweisungen senden | Rote-CI/stale-base mergen; semantische Konflikte raten; `--admin` ohne Mensch |
| **Sub-Agents 1..N** | je eine `query()`-Session, eigener Worktree/Branch (`[[04-sub-agents]]`) | Committen/pushen *eigene* Branch; PR öffnen | **Nie selbst nach `main` mergen**; nicht Datei eines fremden Owners editieren |

---

## 2. Technische Realisierung: Hybrid (Sidecar-Guards + LLM-Agent)

### 2.1 Warum Hybrid (Empfehlung & Begründung)

| Aufgabe | Natur | Wer übernimmt | Begründung |
| --- | --- | --- | --- |
| Reihenfolge: geteilter Code zuerst | mechanisch ableitbar aus `OWNERSHIP_MAP` + Diff-Größe | **Sidecar** | deterministisch, reproduzierbar, testbar |
| `rebase onto origin/main` | git-Mechanik | **Sidecar** | Exit-Code = Wahrheit |
| Konflikt-**Erkennung** | git-Exit + `CONFLICT`-Marker | **Sidecar** | beweisbar |
| Konflikt-**Klassifikation** (mechanisch vs. semantisch) | Urteil über Code-Bedeutung | **LLM** | braucht Verständnis, nicht Pattern |
| mechanische Konflikt-**Lösung** (z. B. Import-Liste, Lockfile-Re-Resolve, Append-Datei) | Urteil + Edit | **LLM** (vom Sidecar getriggert, Ergebnis gegen CI verifiziert) | textuelle, aber nicht-triviale Auflösung |
| Vor-Merge-Gate (CI grün? approved? clean?) | GraphQL-/Exit-Signale | **Sidecar** | beweisbar, false-positive-arm |
| `gh pr merge --squash --delete-branch` | gh-Mechanik | **Sidecar** | einziger Merge-Punkt, auditierbar |
| Security-Review-Urteil | Domänen-Urteil | **LLM** (`security-reviewer`-Subagent) | Befund-Bewertung |
| Anweisungstext an Sub-Agent | Sprache | **LLM** | klare, kontextbezogene Instruktion |
| Eskalations-Briefing an Mensch | Sprache + Zusammenfassung | **LLM** | mensch-lesbare Synthese |

**Kerngrund:** Die paix-Invarianten sind *Sicherheits*-Invarianten. Sie dürfen nicht
von einem stochastischen Modell abhängen, das halluzinieren kann. „Nur grünes CI
mergen" muss ein `if (rollup !== "SUCCESS") return BLOCK;` sein, kein
LLM-„ich glaube das ist okay". Umgekehrt ist „ist dieser textuell saubere Merge
*semantisch* korrekt?" prinzipiell nicht mechanisch entscheidbar — dafür braucht es das
Modell. Der Hybrid setzt die harte Grenze genau dort, wo paix sie zieht.

### 2.2 Komponenten-Diagramm

```text
┌──────────────────────────── Node Sidecar (ein Prozess) ─────────────────────────────┐
│                                                                                      │
│  AgentSession-Pool (siehe [[sidecar-orchestration]])                              │
│    ├─ sub-1 ── query() ── worktree feat/...                                          │
│    ├─ sub-2 ── query() ── worktree feat/...                                          │
│    └─ MAIN_AGENT ── query() ── worktree = main-checkout  (LLM-Urteilsschicht)        │
│                                                                                      │
│  IntegratorEngine  (deterministische Schicht — KEIN LLM)                             │
│    ├─ MergeQueue       : Array<IntegrationItem>  (serialisiert, persistiert)         │
│    ├─ OrderPlanner     : sortiert nach (shared-code? , diff-size, deps)              │
│    ├─ GateChecker      : GraphQL/gh/git -> GateReport                                │
│    ├─ MergeRunner      : rebase -> CI re-run -> gh pr merge -> advance               │
│    ├─ CronScheduler    : prune / cleanup / rebase-reminder / ownership-pflege        │
│    └─ EscalationRouter : -> LLM (Urteil) | -> Mensch (Dashboard)                     │
│                                                                                      │
│  GitHubClient (gh + Octokit GraphQL)   GitClient (git pro Worktree)                  │
└──────────────────────────────────────────────────────────────────────────────────--┘
        │ ruft bei Urteilsfragen                          │ NDJSON
        ▼  (in-process call -> MAIN_AGENT.inbox)          ▼  -> Tauri Core -> UI
   MAIN_AGENT query() liefert klassifiziertes Urteil   integrator_event / escalation
```

### 2.3 Der `MAIN_AGENT` als langlaufende `query()`-Session

Der LLM-Anteil ist eine reguläre `AgentSession` im Pool
(`[[sidecar-orchestration]]` §1.2), mit Sonder-Konfiguration:

```typescript
// IntegratorEngine startet den LLM-Main-Agent (einmal pro App-Run, resume-fähig)
const mainAgent: AgentSession = await startAgent({
  agentId: "MAIN_AGENT",
  role: "integrator",                          // mads-internes Feld, steuert Routing
  prompt: INTEGRATOR_BOOTSTRAP_PROMPT,         // siehe Sektion 8
  branch: "main",
  cwd: mainCheckoutPath,                        // eigener Integrator-Checkout auf main, NICHT ein feat-Worktree (und NICHT von Subs als Worktree genutzt, [[01-architecture]] §3.2)
  model: "claude-opus-4-8",                     // höchste Coding-/Agentic-Qualität (capabilities §11)
  permissionMode: "default",                    // riskante Aktionen laufen durch canUseTool -> Mensch
  systemPrompt: { type: "append", text: INTEGRATOR_SYSTEM_PROMPT },  // Sektion 8
  settingSources: ["project"],                  // lädt CLAUDE.md / .claude/agents/security-reviewer.md
  allowedTools: [
    "Read", "Grep", "Glob",
    "Bash(git status*)", "Bash(git log*)", "Bash(git diff*)",
    "Bash(git rebase*)", "Bash(git merge*)", "Bash(git fetch*)",
    "Bash(gh pr view*)", "Bash(gh pr checks*)", "Bash(gh pr diff*)",
    "Agent",                                     // darf security-reviewer-Subagent spawnen
  ],
  disallowedTools: [
    "Bash(gh pr merge*)",                        // WICHTIG: nur die IntegratorEngine merged, nicht der LLM
    "Bash(git push origin main*)",
    "Bash(*--admin*)",
  ],
  agents: {                                      // dynamischer Security-Subagent (capabilities §7.2)
    "security-reviewer": {
      description: "Reviewt einen Diff auf Sicherheitsbefunde und semantische Risiken.",
      prompt: SECURITY_REVIEWER_PROMPT,          // Sektion 5.2
      tools: ["Read", "Grep", "Glob"],
      model: "claude-opus-4-8",
    },
  },
});
```

**Wichtige Designentscheidung — der LLM darf nicht mergen.** `gh pr merge` steht im
`MAIN_AGENT` auf `disallowedTools`. Der eigentliche Merge wird *ausschließlich* von der
`MergeRunner`-Komponente der `IntegratorEngine` als direkter `gh`-Childprozess
ausgeführt — nachdem der `GateChecker` deterministisch grün gemeldet hat. So bleibt der
Merge-Punkt ein einziger, auditierbarer, nicht-stochastischer Ort. Das ist die
striktest-mögliche Lesart von „nur der Integrator merged" + „der Integrator rät nicht".

**Main-Commit-Gate (bewusste Maintainer-Zustimmung).** Da der Integrator-Worktree *der*
`main`-Checkout ist, landet jeder `git commit` des `MAIN_AGENT` direkt auf `main`. Damit das
nie *still* geschieht (auch nicht im Auto-Modus, in dem lokale Commits sonst ohne Rückfrage
durchlaufen), löst ein `git commit` des Integrators in `canUseTool` **immer** eine
Permission-Rückfrage aus (`isGitCommit` in `shared/safe-command.ts` → erzwungenes
`promptPermission`, siehe `sidecar/src/session.ts`). Der Maintainer stimmt bewusst zu — oder
lehnt ab, dann gehört die Arbeit in einen Sub-Stream/Branch + PR. Greift nicht bei
`bypassPermissions` (dort sind Prompts bewusst abgeschaltet) und nicht beim gegateten
`gh pr merge` (läuft serverseitig über die Engine, nicht per Bash). Operationalisiert OE-16.

> **OFFENE FRAGE (A1):** Soll der `MAIN_AGENT` *überhaupt* `git rebase`/`git merge`
> ausführen dürfen (für mechanische Konfliktlösung), oder soll auch das die
> `IntegratorEngine` deterministisch starten und den LLM nur für den *Edit* der
> Konfliktmarker rufen? Empfehlung im Dokument: Engine triggert, LLM editiert nur
> Konflikt-Hunks; Engine verifiziert via CI. Review soll bestätigen, ob der LLM eigene
> git-Mechanik fahren darf oder strikt nur Datei-Edits.

### 2.4 Datenmodell der Integrations-Schicht

```rust
// Rust-Core-Spiegel (Persistenz in [[01-architecture]]); Sidecar hält TS-Pendant.
#[derive(Serialize, Deserialize, Clone)]
pub struct IntegrationItem {
    pub pr_number: u64,
    pub branch: String,
    pub owner_agent_id: String,         // welcher Sub-Agent besitzt die Branch
    pub head_sha: String,               // fuer --match-head-commit (force-with-lease-Pendant)
    pub touches_shared: bool,           // beruehrt OWNERSHIP_MAP-Shared-Seam?
    pub diff_size: u32,                 // Tie-Break: kleinerer Diff zuerst
    pub depends_on: Vec<u64>,           // Stack-Modellierung (Schema -> API -> UI)
    pub state: IntegrationState,
    pub last_gate: Option<GateReport>,
    pub attempts: u8,                   // Re-Run-Zaehler, Backoff/Eskalation
}

#[derive(Serialize, Deserialize, Clone, PartialEq)]
pub enum IntegrationState {
    Queued,
    Selected,
    Rebasing,
    CiRunning,
    GateCheck,
    Merging,
    Merged,
    SentBackToOwner { reason: String },   // semantischer Konflikt / rote CI / stale base
    EscalatedToHuman { reason: String },
    Failed { reason: String },
}
```

```typescript
// Sidecar-seitiges Gate-Ergebnis (deterministisch befuellt, KEINE LLM-Felder)
interface GateReport {
  prNumber: number;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  mergeStateStatus:
    | "CLEAN" | "HAS_HOOKS" | "BEHIND" | "BLOCKED"
    | "DIRTY" | "DRAFT" | "UNSTABLE" | "UNKNOWN";
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  ciRollup: "SUCCESS" | "FAILURE" | "ERROR" | "PENDING" | "EXPECTED" | null;
  behindBy: number;                 // git rev-list origin/main ^HEAD (lokal, ohne API)
  secretScanClean: boolean;
  lockfileFrozenOk: boolean;        // npm ci / cargo --locked ohne Drift
  verdict: "PASS" | "BLOCK" | "RECHECK";   // RECHECK bei UNKNOWN (lazy mergeable, [[github-multiagent]] §3.5)
  blockingReasons: string[];        // mensch-lesbar, fuer Dashboard/Eskalation
}
```

---

## 3. Integrations-/Merge-Prozedur (paix Sektion 7, ausführbar)

### 3.1 Grundsatz

> **Nicht** N Branches simultan mergen. **Serialisieren.** (paix §7, Zeile 274)
> 1) Branch wählen → 2) onto frisches `main` rebasen → 3) CI re-run → 4) mergen →
> 5) `main` rückt vor → 6) nächste Branch onto das NEUE `main` rebasen → wiederholen.

### 3.2 Reihenfolge-Bestimmung (`OrderPlanner`)

Implementiert paix §7 „Integrations-Reihenfolge" deterministisch:

```typescript
function planOrder(items: IntegrationItem[]): IntegrationItem[] {
  // 1) Dependency-Topologie zuerst (Stack: Schema -> API -> UI)
  const topo = topologicalSort(items, i => i.depends_on);
  // 2) Innerhalb gleicher Topo-Ebene: shared-code-Branch zuerst (paix §7)
  // 3) Tie-Break: kleinerer Diff / weniger Down-stream-Abhaengige zuerst
  return topo.sort((a, b) => {
    if (a.touches_shared !== b.touches_shared) return a.touches_shared ? -1 : 1;
    if (a.diff_size !== b.diff_size) return a.diff_size - b.diff_size;
    return downstreamCount(a) - downstreamCount(b);
  });
}
```

`touches_shared` und `depends_on` kommen aus der `OWNERSHIP_MAP`
(`[[01-architecture]]`); ist die Reihenfolge bei zwei gleichwertigen Branches
mehrdeutig (zyklische Abhängigkeit, beide am selben Seam) → **OrderPlanner ruft den
`MAIN_AGENT`** für einen begründeten Tie-Break, statt zu raten (Sektion 6,
Eskalations-Pfad „Ambiguität").

### 3.3 Zustandsmaschine (pro `IntegrationItem`)

```text
                 ┌─────────┐
                 │ Queued  │
                 └────┬────┘
        OrderPlanner waehlt naechstes (FIFO nach planOrder)
                      ▼
                 ┌──────────┐   behindBy==0 & no conflict
                 │ Selected ├───────────────┐
                 └────┬─────┘                │
            git rebase origin/main           │
                      ▼                       ▼
                 ┌──────────┐  CONFLICT  ┌──────────┐
                 │ Rebasing ├───────────►│ classify │ (LLM: mechanisch|semantisch)
                 └────┬─────┘            └────┬─────┘
        rebase ok     │              mechanisch│        semantisch
                      ▼                        ▼              ▼
                 ┌──────────┐         (LLM loest Hunks)  SentBackToOwner
                 │CiRunning │◄────────  zurueck zu Rebasing  (reason)
                 └────┬─────┘
        push --force-with-lease; CI re-run auf neuer Basis
                      ▼
                 ┌──────────┐  verdict=RECHECK ┌─────────┐
                 │ GateCheck├─────────────────►│ re-poll │ (UNKNOWN lazy, [[github-multiagent]] §3.5)
                 └────┬─────┘                  └────┬────┘
         verdict=PASS │   verdict=BLOCK             │ -> GateCheck
                      ▼        │
                 ┌──────────┐  │ (rote CI / not approved / stale)
                 │ Merging  │  └──────────────► SentBackToOwner | EscalatedToHuman
                 └────┬─────┘
   gh pr merge --squash --delete-branch --match-head-commit <head_sha>
                      ▼
                 ┌──────────┐  main rueckt vor -> naechstes Item onto NEUES main
                 │  Merged  │  -> cleanup(worktree, branch) -> OrderPlanner: next
                 └──────────┘
```

### 3.4 Sequenzdiagramm (eine Serialisierungs-Runde)

```text
IntegratorEngine        GitClient(worktree)   GitHub(gh/GraphQL)   MAIN_AGENT(LLM)   Mensch(UI)
      │                        │                     │                  │              │
 1. select(item)              │                     │                  │              │
      │── git fetch ─────────►│                     │                  │              │
      │── git rebase main ───►│                     │                  │              │
      │◄── exit 0 / CONFLICT ─│                     │                  │              │
      │                        │                     │                  │              │
   [CONFLICT]                  │                     │                  │              │
      │── classify(diff) ─────────────────────────────────────────────►│              │
      │◄── "mechanical" | "semantic" ──────────────────────────────────│              │
      │   [semantic] -> SentBackToOwner; send_input(owner); continue    │              │
      │   [mechanical] -> LLM editiert Hunks -> re-rebase               │              │
      │                        │                     │                  │              │
 2. push --force-with-lease ──►│                     │                  │              │
      │── trigger CI ──────────────────────────────►│                  │              │
      │── poll checks (--watch / GraphQL) ──────────►│                  │              │
      │◄── rollup=SUCCESS ──────────────────────────│                  │              │
      │                        │                     │                  │              │
 3. GateCheck (GraphQL batch) ────────────────────►│                  │              │
      │◄── mergeStateStatus=CLEAN, reviewDecision=APPROVED              │              │
      │   secretScan + lockfileFrozen (lokal) -> verdict=PASS           │              │
      │                        │                     │                  │              │
 4. gh pr merge --squash --match-head-commit ──────►│                  │              │
      │◄── merged ──────────────────────────────────│                  │              │
      │── cleanup(worktree/branch) ──►│              │                  │              │
      │── integrator_event(merged) ─────────────────────────────────────────────────►│
      │                                                                               │
 5. OrderPlanner.next() -> rebase naechstes Item onto NEUES main -> wiederhole
```

### 3.5 Mechanischer vs. semantischer Konflikt (paix §7, Entscheidungspunkt)

Dies ist der zentrale Hybrid-Übergabepunkt:

| Konflikt-Typ | Erkennung | Wer löst | Aktion |
| --- | --- | --- | --- |
| **Mechanisch/textuell** | `git rebase` Exit≠0 + `<<<<<<<`-Marker; LLM klassifiziert „beide Seiten unabhängig, Auflösung ist Zusammenführen" (z. B. Import-Listen, Append-Dateien wie `BACKLOG.md`, Lockfile-Re-Resolve) | **Integrator** (LLM editiert Hunks, Engine verifiziert via CI) | Hunks zusammenführen → re-rebase → CI re-run; bei grün weiter zu GateCheck |
| **Semantisch** | Code merged *textuell sauber* (oder Konflikt, dessen Auflösung Domänen-Wissen braucht), ist aber logisch falsch — z. B. zwei Branches ändern dieselbe Funktions-Semantik gegenläufig, geänderte Contract-Signatur | **Owner** (Sub-Agent) | `SentBackToOwner{reason}`: `send_input` an Owner mit konkretem Auftrag „rebase + diese Stelle fixen", PR-Comment als Audit-Artefakt |
| **Nicht entscheidbar** | LLM unsicher *oder* Konflikt berührt Contract/ADR | **Mensch** | `EscalatedToHuman` (Sektion 6) |

**Klassifikations-Aufruf an den LLM (deterministisch getriggert):**

```typescript
// IntegratorEngine ruft MAIN_AGENT mit strukturierter Frage; Antwort via outputFormat-Schema
const verdict = await askMainAgent({
  task: "classify_conflict",
  prNumber: item.pr_number,
  conflictHunks,                       // die rohen <<< === >>> Bloecke
  ownershipContext: ownershipFor(item.branch),
  schema: {                            // capabilities §9.3 outputFormat json_schema
    type: "object",
    properties: {
      kind: { enum: ["mechanical", "semantic", "unsure"] },
      rationale: { type: "string" },
      resolutionHint: { type: "string" },   // nur bei mechanical
    },
    required: ["kind", "rationale"],
  },
});
if (verdict.kind === "semantic") return sendBackToOwner(item, verdict.rationale);
if (verdict.kind === "unsure")   return escalateToHuman(item, verdict.rationale);
// mechanical: LLM editiert Hunks (eigener send_input mit resolutionHint), dann re-rebase + CI
```

### 3.6 Fehlerfälle der Merge-Prozedur

| Fehlerfall | Signal | Reaktion der Engine |
| --- | --- | --- |
| Rebase-Konflikt | `git rebase` Exit≠0, `CONFLICT` | → classify (Sektion 3.5) |
| `push --force-with-lease` rejected | Exit≠0, stderr `! [rejected]`/`stale info` | jemand hat die Remote-Branch bewegt → re-fetch, re-rebase; bei Wiederholung Eskalation (`code: git_push_rejected`, [[github-multiagent]] §4) |
| CI rot nach Rebase | `statusCheckRollup ∈ {FAILURE,ERROR}` / `gh pr checks` Exit 1 | `SentBackToOwner{ "CI rot auf rebase-onto-fresh-main" }` — nie mergen (paix §7) |
| `mergeStateStatus=BEHIND` | GraphQL | stale base → re-rebase, nicht mergen |
| `mergeStateStatus=DIRTY` / `mergeable=CONFLICTING` | GraphQL | echter Merge-Konflikt → classify |
| `mergeStateStatus=BLOCKED` | GraphQL | Required Review/Check fehlt → GateCheck verdict BLOCK → Owner/Mensch |
| `mergeable=UNKNOWN` | GraphQL (lazy, [[github-multiagent]] §3.5) | **kein Alarm** → `verdict=RECHECK`, Re-Poll nach 1–3 s |
| `gh pr merge` schlägt fehl (`--match-head-commit` mismatch) | Exit≠0 | Head wanderte zwischen GateCheck und Merge → zurück zu Selected, neu rebasen |
| `gh` Auth weg | Exit 4 | `EscalatedToHuman{ "gh auth required" }`, gesamte Engine pausieren |

---

## 4. Quality- & Security-Gates (was der Main-Agent erzwingt)

Jedes Gate ist **deterministisch im Sidecar** geprüft (außer das Security-*Urteil*).
Kein einziges davon ist optional vor einem Merge.

### 4.1 Gate-Reihenfolge (alle müssen PASS sein vor `Merging`)

```text
1. lockfileFrozenOk   : npm ci  (JS/TS) + cargo build --locked (Rust)  -> kein Drift
                        ([[github-multiagent]] §8: zwei Lockfile-Achsen, paix §9 Determinismus)
2. lint/type/test     : npm run lint && npm run typecheck && npm test ; cargo test
                        -> identisches, frozen CI auf rebase-onto-fresh-main (paix §5)
3. ciRollup==SUCCESS  : GitHub-CI gruen (GraphQL statusCheckRollup) — die maschinelle
                        Wahrheit, nicht nur lokal
4. secretScanClean    : gitleaks/trufflehog ueber den PR-Diff ([[claude-code-capabilities]])
5. securityReview     : security-reviewer-Subagent (LLM-Urteil) -> kein BLOCKER-Befund
6. reviewDecision     : APPROVED (Mensch oder, falls Policy erlaubt, Integrator-Approval)
7. mergeStateStatus   : CLEAN | HAS_HOOKS   (nicht BEHIND/DIRTY/BLOCKED/UNSTABLE)
```

> **Invariante:** „Nie rote-CI / stale-base mergen" (paix §7) = harte Bedingung
> `verdict = (ciRollup==="SUCCESS" && behindBy===0 && mergeStateStatus∈{CLEAN,HAS_HOOKS}
> && reviewDecision==="APPROVED" && secretScanClean && lockfileFrozenOk && noBlockerFinding)
> ? "PASS" : "BLOCK"`.

### 4.2 Security-Review via Subagent (paix-Analogie: PAIX `security-reviewer`)

Der `MAIN_AGENT` spawnt den `security-reviewer`-Subagent (capabilities §7.2, dynamisch
via `agents`-Option) über das `Agent`-Tool. Wichtig (capabilities §9.4, Caveat
sidecar-orchestration §9.2): Subagents können **kein** `AskUserQuestion` und erben den
Permission-Mode des Parents — der Reviewer ist daher **read-only** (`tools: [Read, Grep,
Glob]`) und gibt nur ein strukturiertes Urteil zurück, committet nichts.

```text
Trigger: GateChecker erreicht Step 5 (nach gruenem CI, vor reviewDecision).
Input:  PR-Diff (gh pr diff <pr>), geaenderte Dateien, OWNERSHIP-Kontext.
Output (json_schema): {
  findings: [{ severity: "blocker"|"warn"|"info", file, line?, issue, recommendation }],
  verdict: "pass" | "block",
}
Regel:  ein einziger severity=="blocker" -> GateReport.verdict=BLOCK
        -> SentBackToOwner (mit Befund als PR-Comment) ODER EscalatedToHuman
           (wenn Befund eine Architektur-/Contract-Frage ist).
```

Findet der Reviewer beim Lesen *unrelated* Code-Risiken (außerhalb des PR-Scope),
werden diese als separate Backlog-Items / Tasks geführt — nicht in den laufenden Merge
gezogen (vermeidet Scope-Bloat).

### 4.3 Secret-Scan & Frozen-Lockfile-Check (mechanisch)

```bash
# Secret-Scan ueber den PR-Diff (Detail: [[claude-code-capabilities]])
gitleaks protect --staged --no-banner            # bzw. trufflehog filesystem
# Frozen-Lockfile: ENtscheidet green-branch == green-main (paix §9)
npm ci                                            # bricht ab, wenn package-lock.json driftet
cargo build --locked                              # bricht ab, wenn Cargo.lock driftet
# Bumpen zwei Branches dasselbe Lockfile -> geteilter Datei-Edit (paix §6):
#   land-first ODER single-owner; die Engine erzwingt die Reihenfolge im OrderPlanner.
```

---

## 5. Periodische Aufgaben (cron-artig im Sidecar)

Der `CronScheduler` der `IntegratorEngine` fährt diese Jobs auf festem Intervall
(getimt im Sidecar, **nicht** als externe cron — der Sidecar ist der einzige IO-Ort).
Jeder Job ist idempotent und read-mostly; mutierende Schritte (Branch löschen,
Worktree entfernen) laufen nur nach mechanischer Sicherheitsprüfung.

| Job | Intervall (Default) | Aktion | paix-Bezug |
| --- | --- | --- | --- |
| `stale-worktree-prune` | 15 min | `git worktree list --porcelain` → verwaiste/`prunable` finden, `git worktree prune`; nie `rm -rf` | §4 Fallstricke, §12.2 |
| `branch-cleanup` | nach jedem Merge + 30 min | gemergte Branches (`git merge-base --is-ancestor`) lokal `git branch -d` + remote `git push origin --delete`; refuse bei dirty | §5 Teardown, §12.2 |
| `rebase-reminder` | 30 min (adaptiv, schneller wenn `main` heiß) | pro aktiver Sub-Branch `behindBy = git rev-list --count origin/main ^HEAD`; > Schwelle → `send_input` „rebase jetzt" + Dashboard-Badge | §5 Cadence (≥1×/Tag), Stale-Base-Killer |
| `ownership-map-pflege` | bei Spawn/Merge + 60 min | `OWNERSHIP_MAP` mit aktiven Branches/Dateien abgleichen; Überlapp-Erkennung → Warnung/Serialisierung | §6 Ownership-Map |
| `trespass-scan` | 15 min + vor jedem Merge | aktive Worktrees gegen das `CoordinationArtifact` prüfen (`git diff` → `ChangedRegion[]` → `detectTrespass`); Treffer → `ownership_trespass`-Eskalation, Owner-Handoff/land-first verfügen ([[06-ownership-and-coordination]]) | §6 Konfliktvermeidung |
| `backlog-sync` | 60 min | `BACKLOG.md` / Task-State (`[[01-architecture]]`) gegen offene PRs/Sessions konsistent halten | §8 Backlog |
| `dashboard-poll` | 15–30 s adaptiv, Jitter | GraphQL-Batch über alle PRs (`[[github-multiagent]] §4.1`) → Eskalations-Signale | §5 Polling |

```typescript
// CronScheduler-Skizze (Sidecar). Intervalle konfigurierbar in [[01-architecture]].
interface CronJob { id: string; everyMs: number; run: () => Promise<void>; lastRun: number; }

const jobs: CronJob[] = [
  { id: "stale-worktree-prune", everyMs: 15*60_000, run: pruneStaleWorktrees, lastRun: 0 },
  { id: "branch-cleanup",       everyMs: 30*60_000, run: cleanupMergedBranches, lastRun: 0 },
  { id: "rebase-reminder",      everyMs: 30*60_000, run: remindStaleBranches, lastRun: 0 },
  { id: "ownership-map-pflege", everyMs: 60*60_000, run: reconcileOwnership, lastRun: 0 },
  { id: "trespass-scan",        everyMs: 15*60_000, run: scanTrespass, lastRun: 0 },  // [[06-ownership-and-coordination]]
  { id: "backlog-sync",         everyMs: 60*60_000, run: syncBacklog, lastRun: 0 },
  { id: "dashboard-poll",       everyMs: 20_000,    run: pollDashboard, lastRun: 0 },
];

async function remindStaleBranches() {
  for (const s of pool.values()) {
    if (s.role !== "sub" || s.status === "done") continue;
    const behind = await git(["-C", s.worktreePath, "rev-list", "--count", "origin/main", "^HEAD"]);
    if (Number(behind) > STALE_THRESHOLD) {            // OFFENE FRAGE C1: Schwelle
      send(needsInput(s.agentId, "rebase_reminder",
        `Deine Branch ist ${behind} Commits hinter origin/main. Bitte rebase jetzt (sync).`));
    }
  }
}
```

> **OFFENE FRAGE (C1):** Konkrete Schwellen/Intervalle (`STALE_THRESHOLD`,
> Rebase-Reminder-Frequenz, „main heiß"-Definition) sind empirisch zu kalibrieren —
> paix nennt nur „mindestens 1×/Tag, mehr wenn `main` heiß". Default-Vorschlag oben;
> Review soll bestätigen oder anpassen.

---

## 6. Anweisungen an Sub-Agents & Konfliktvermeidungs-Protokoll

### 6.1 Kanal-Wahl: committete Artefakte vs. direkte Sidecar-Messages

paix §8 ist eindeutig: **dauerhafter, geteilter Zustand lebt in committeten Artefakten**
(ADR, Backlog, Ownership-Map), nicht in flüchtigem Chat. mads kombiniert beide Kanäle
nach Persistenz-Bedarf:

| Anweisungs-Typ | Kanal | Persistent? | Beispiel |
| --- | --- | --- | --- |
| Eingefrorener Contract / Invariante | **ADR** (`docs/decisions/`), committet | ja | „API-Signatur X ist final" |
| Ownership / wer besitzt welche Datei | **`OWNERSHIP_MAP`** / `CODEOWNERS`, committet | ja | „`shared.ts` gehört Branch A" |
| Task-Claim / Status / Abhängigkeit | **`BACKLOG`** / Task-State, committet | ja | „Task 7 = sub-3, depends 4" |
| Flüchtige operative Anweisung | **direkte Sidecar-Message** (`send_input`) | nein (aber als PR-Comment gespiegelt für Audit) | „rebase jetzt", „du besitzt Datei X nicht" |
| Semantischer-Konflikt-Rückgabe | **`send_input` + PR-Comment** | PR-Comment ja | „diese Auflösung ist logisch falsch, weil …" |

**Regel:** Alles, was eine *Entscheidung* oder einen *Vertrag* darstellt, wird als
committetes Artefakt verankert (überlebt Agent-Resets, auditierbar). Operative
„tu-jetzt-X"-Nachrichten gehen als `send_input` über den Sidecar — aber sicherheits-/
audit-relevante (Konflikt-Rückgabe, Security-Befund) werden zusätzlich als
**PR-Comment** gespiegelt (`gh pr comment`), damit sie persistent und im
GitHub-Kontext sichtbar sind.

> **OFFENE FRAGE (B1):** Append-Dateien (`BACKLOG.md`, ADR-Index) konfligieren textuell,
> wenn der Integrator und ein Sub-Agent gleichzeitig anhängen (paix §8 Warnung).
> Lösung: **nur der Integrator** schreibt diese Append-Dateien (Single-Owner für
> Koordinations-Artefakte); Sub-Agents *lesen* sie und melden Claims über `send_input`,
> die Engine schreibt. Review soll bestätigen, ob Sub-Agents je direkt in
> Koordinations-Artefakte schreiben dürfen.

### 6.2 Konfliktvermeidungs-Protokoll automatisiert (paix §6, Option A/B)

Der Integrator erzwingt die paix-Entscheidungsregel mechanisch beim Planen paralleler
Arbeit (vor dem Spawn von Sub-Agents) und kontinuierlich via `ownership-map-pflege`:

```text
Beim Dispatch neuer paralleler Tasks (OrderPlanner-Vorstufe):
  fuer jedes Paar (task_i, task_j):
    overlap = files(task_i) ∩ files(task_j)
    if overlap == ∅:                 -> parallel erlaubt (verschiedene git-Objekte)
    else:
      sharedChange = beschreibe(overlap)
      if klein & self-contained:     -> OPTION A (land-first):
            winzigen PR nur fuer overlap erzeugen, ZUERST mergen,
            dann beide Tasks onto neues main rebasen (enthalten die Aenderung schon)
      else:                          -> OPTION B (single-owner):
            genau EIN Owner-Branch fuer overlap (in OWNERSHIP_MAP/CODEOWNERS),
            in Integrations-Reihenfolge ZUERST sequenziert;
            der andere Task beruehrt overlap NICHT -> fordert Aenderung an / wartet
```

**Entscheidungsregel (paix §6):** geteilte Änderung klein & self-contained → Option A;
groß & mit Task-Logik verflochten → Option B. Diese Klassifikation („klein/groß,
self-contained/verflochten") ist eine **Urteilsfrage** → der `OrderPlanner` ruft bei
Mehrdeutigkeit den `MAIN_AGENT`; klare Fälle (Lockfile-Bump, reine Datei-Existenz)
entscheidet die Engine selbst.

### 6.2a Koordinations-Artefakt & Region-Ownership (Single-Writer Integrator)

Wo zwei Streams **dieselbe Datei in verschiedenen Regionen** anfassen müssen, reicht
datei-grobe Ownership nicht — der Integrator verfeinert sie auf **Sub-Datei-Ebene**
(Symbol-/Pattern-Anker) und macht das Trespass-Gate erzwingbar (vollständiges Modell:
[[06-ownership-and-coordination]]). Der Integrator ist der **alleinige Bewirtschafter**
dieses Artefakts (kohärent mit OE-14, Single-Owner für Koordinations-Dateien):

- **Erzeugen & pflegen (Single-Writer).** Beim Dispatch paralleler Streams baut der
  Integrator die Ownership-Map *bevor* Code geschrieben wird, schneidet Tasks entlang
  Datei-/Symbol-Grenzen, weist geteilte Nähte **genau einem** Owner zu und committet das
  `CoordinationArtifact` als `docs/coordination/<name>.md`. Sub-Agents **lesen** es nur.
- **Trespass-Gate periodisch erzwingen.** Der `CronScheduler` (§5) scannt aktive Worktrees
  gegen die `OwnershipRule[]` (`detectTrespass`) und warnt früh — noch bevor ein Sub-Agent
  pushen will (zusätzlich zum Sub-Agent-Pre-PR-Self-Check, [[04-sub-agents]]).
- **Owner-Handoff verfügen.** Muss ein Nicht-Owner eine fremde Naht ändern, weist der
  Integrator die Region neu zu (Artefakt-Update) **oder** ordnet einen `land_first`-PR an —
  statt die Naht heimlich parallel zu ändern.
- **Nach Merge löschen.** Das Artefakt ist **transient**: nach Merge beider Streams
  `status: "resolved"` → Datei löschen (nie ein veraltetes Artefakt herumliegen lassen).

### 6.3 Konkrete Anweisungs-Nachricht (NDJSON)

Direkte Anweisungen reisen über das bestehende `send_input` aus
`[[sidecar-orchestration]]` §3.2, angereichert um einen `directive`-Hint fürs UI:

```jsonc
// HOST(IntegratorEngine als interner Sender) -> SIDECAR -> Sub-Agent.inbox
{
  "v": 1, "id": "...", "ts": 1718800000000,
  "type": "send_input",
  "agentId": "sub-3",
  "text": "INTEGRATOR-ANWEISUNG: Deine Branch feat/login ist 12 Commits hinter origin/main und berührt die geteilte Datei src/api/contract.ts, deren Owner feat/schema ist. Bitte (1) rebase onto origin/main, (2) entferne deine Änderung an contract.ts — fordere sie stattdessen bei feat/schema an. Begründung siehe PR-Comment.",
  "directive": { "kind": "rebase_and_unown", "files": ["src/api/contract.ts"], "ownerBranch": "feat/schema", "prComment": true }
}
```

---

## 7. Eskalation an den Menschen

Der Integrator zieht den Menschen, wenn eine Situation **weder mechanisch lösbar noch
sicher LLM-delegierbar** ist. Eskalation ist ein erstklassiger Zustand
(`EscalatedToHuman`) und blockiert das betroffene Item (nicht die ganze Queue, außer bei
Auth/Sicherheits-Stop).

### 7.1 Eskalations-Trigger

| Trigger | Quelle | Warum Mensch (nicht LLM/Engine) |
| --- | --- | --- |
| **Domänen-/Architektur-Konflikt** | LLM-Klassifikation `unsure` oder Konflikt berührt ADR/Contract | Vertrag ist menschen-besessen (paix §8); Änderung ist „Stop-the-world" |
| **Security-Befund (blocker)** mit Architektur-Implikation | `security-reviewer` verdict=block + nicht-lokal fixbar | Risiko-Akzeptanz ist menschliche Entscheidung ([[claude-code-capabilities]]) |
| **Mehrdeutige Reihenfolge / zyklische Abhängigkeit** | `OrderPlanner` kann nicht topologisch sortieren | Priorisierung ist ein Produkt-/Mensch-Urteil |
| **Wiederholter Fehlschlag** | `attempts > MAX_ATTEMPTS` (rebase/CI/push) | automatischer Loop bringt nichts mehr |
| **`gh` Auth weg / Setup kaputt** | `gh` Exit 4; Secure-Storage nicht aktiv ([[github-multiagent]] §7) | nur Mensch kann re-authentifizieren |
| **`--admin`-Merge gewünscht** | Gate dauerhaft nicht erfüllbar, Mensch will trotzdem landen | Gates umgehen ist auditierte Mensch-Ausnahme (paix §7 / [[github-multiagent]] §3.4) |
| **Risiko-Tool ohne Auto-Regel** | `canUseTool` „ask" für destruktives Tool im `MAIN_AGENT` | Mensch-im-Loop |

### 7.2 Eskalations-Nachricht (NDJSON, an Tauri-Core/UI)

```typescript
interface EscalationMsg extends BaseMsg {
  type: "escalation";
  agentId: "MAIN_AGENT";
  itemRef: { prNumber?: number; branch?: string };
  category:
    | "domain_conflict" | "security_finding" | "order_ambiguity"
    | "repeated_failure" | "auth_broken" | "admin_merge_request" | "risky_tool";
  severity: "info" | "warn" | "block";
  // vom LLM erzeugtes mensch-lesbares Briefing (Synthese), NICHT roher Stacktrace:
  summary: string;
  details: string;
  options: Array<{ id: string; label: string; effect: string }>;  // was der Mensch klicken kann
}
```

Das `summary`/`details`-Briefing wird vom `MAIN_AGENT` (LLM) formuliert — eine klare,
kontextreiche Erklärung statt Roh-Logs. Die `options` (z. B. „Zurück an Owner",
„`--admin`-Merge mit Begründung", „Reihenfolge: A vor B") werden im
Integrator-Dashboard (`[[02-dashboard]]`) als Buttons gerendert; die Antwort kommt als
`answer_permission` / `send_input` zurück und treibt die Zustandsmaschine weiter. Push-
Benachrichtigung (macOS) bei `severity=block` (`[[02-dashboard]]` /
`[[02-dashboard]]`-Notifications).

---

## 8. System-Prompt-Skizze / CLAUDE.md-Auszug für den Main-Agent

> Dies ist der **`append`-System-Prompt** des `MAIN_AGENT` (capabilities §9.3,
> `systemPrompt: { type: "append" }`) plus der relevante CLAUDE.md-Auszug, den alle
> Agents lesen (paix §8: menschen-besessen, Agents *lesen*, schreiben nicht).

### 8.1 `INTEGRATOR_SYSTEM_PROMPT` (append)

```text
Du bist der INTEGRATOR (Main-Agent) von mads. Du verwaltest die Branch `main`.

DEINE INVARIANTEN (niemals brechen):
1. Nur DU landest auf `main`. Sub-Agents schlagen via PR vor; sie mergen NIE selbst.
2. `main` ist IMMER lauffähig. Du merderst NIE eine PR mit roter CI oder veralteter Basis
   (stale base / BEHIND). Im Zweifel: zurück an den Owner zum rebase + CI-re-run.
3. Du RÄTST NICHT bei semantischen Konflikten. Textuell-mechanische Konflikte
   (Import-Listen, Append-Dateien, Lockfile-Re-Resolve) löst du. Konflikte, deren
   Auflösung Domänen-Wissen braucht oder die einen Contract/ein ADR berühren, gehen
   ZURÜCK an den Owner-Sub-Agent oder, wenn unklar, an den Menschen.

DEINE WERKZEUGE & GRENZEN:
- Du führst `gh pr merge` NICHT selbst aus. Den eigentlichen Merge löst die
  deterministische IntegratorEngine aus, NACHDEM alle Gates beweisbar grün sind. Deine
  Aufgabe ist Urteil + Vorbereitung, nicht das Drücken des Merge-Knopfes.
- Du editierst KEINEN Feature-Code in Sub-Branches. Dein Worktree ist der main-Checkout.
- Du änderst NIE CLAUDE.md / AGENTS.md / ADRs eigenmächtig (menschen-besessen). Du liest sie.

INTEGRATIONS-REIHENFOLGE:
- Branch, die geteilten/fundamentalen Code (Schema, geteiltes Modul, Lockfile) anfasst,
  ZUERST. Dann abhängige. Modelliere abhängige Arbeit als Stack (Schema -> API -> UI).
  Tie-Break: kleinerer Diff / weniger Down-stream-Abhängigkeiten zuerst.
- Serialisiere IMMER: rebase onto frisches main -> CI re-run -> merge -> nächste Branch
  onto das NEUE main. Nie N Branches gleichzeitig.

GATES (alle müssen grün sein, bevor gemerged wird):
  frozen-lockfile-install · lint · type-check · test · CI-rollup=SUCCESS ·
  secret-scan clean · security-reviewer ohne blocker · review APPROVED ·
  mergeStateStatus ∈ {CLEAN, HAS_HOOKS}.

ANWEISUNGEN AN SUB-AGENTS:
- Verträge/Ownership/Tasks -> committete Artefakte (ADR / OWNERSHIP_MAP / BACKLOG).
- Operative „tu-jetzt-X"-Anweisungen -> direkte Nachricht; sicherheits-/konflikt-relevante
  zusätzlich als PR-Comment (Audit).
- Konfliktvermeidung: überlappende Datei-Listen NIE parallel. Klein+self-contained ->
  land-first (Option A); groß+verflochten -> single-owner (Option B).

ESKALATION AN DEN MENSCHEN, wenn:
- ein Konflikt Domänen-Wissen/Contract/ADR berührt und du unsicher bist,
- ein Security-Befund Architektur-Implikationen hat,
- die Integrations-Reihenfolge mehrdeutig/zyklisch ist,
- wiederholte automatische Versuche scheitern,
- gh-Auth kaputt ist oder ein `--admin`-Merge nötig wäre.
Formuliere dann ein klares, kontextreiches Briefing (Lage, Optionen, Empfehlung) —
keine Roh-Logs.

SECURITY-REVIEW:
- Vor `review APPROVED` spawnst du den `security-reviewer`-Subagent (read-only) auf den
  PR-Diff. Ein einziger blocker-Befund blockiert den Merge.
```

### 8.2 CLAUDE.md-Auszug (geteilt, menschen-besessen — Integrator-relevanter Teil)

```markdown
## Integrations-Regeln (gelten für alle Agents)

- `main` ist protected: PR-only, required CI (lint/type/test), required Review.
- NUR der Integrator (Main-Agent) merged. Sub-Agents öffnen PRs, mergen NIE selbst.
- Rebase deine Branch mindestens 1×/Tag onto `origin/main` (öfter, wenn `main` heiß ist).
  „Grün auf meiner Branch" zählt erst nach rebase-onto-fresh-main + frozen-CI.
- Bevorzuge NEUE Dateien statt geteilte zu modifizieren. Überlappende Datei-Listen
  werden serialisiert, nicht parallelisiert (land-first oder single-owner).
- Geteilte Seams (Lockfiles `package-lock.json`/`Cargo.lock`, zentrale Registries, i18n,
  ADR-Index, BACKLOG.md) haben genau EINEN Owner; Änderungen folgen dem Shared-File-Protokoll.
- Lockfiles sind committet; CI installiert frozen (`npm ci`, `cargo build --locked`).
- `git config rerere.enabled true` ist gesetzt (Wiederhol-Konflikte werden auto-replayt).
- Force-Push nur mit `--force-with-lease`, nie `--force`. Nie public/shared History rebasen.
```

---

## 9. Zusammenspiel & Crash-Recovery (Kurz)

- Die **Integrator-Queue** (`MergeQueue: IntegrationItem[]`) wird wie `agents.json`
  atomar persistiert (`[[01-architecture]]`, write-temp + rename). Nach
  App-/Sidecar-Neustart liest die `IntegratorEngine` die Queue, verifiziert jeden Item-
  Zustand frisch gegen GitHub (GraphQL) — denn `main` kann sich geändert haben — und
  nimmt die Serialisierung wieder auf. Kein Item wird „blind" weitergemerged.
- Beim Reconnect (`sidecar_ready`, sidecar-orchestration §7.2) wird der `MAIN_AGENT`
  bevorzugt via `resume: sessionId` fortgesetzt (LLM-Kontext bleibt erhalten); fehlt die
  Session, wird er mit `INTEGRATOR_BOOTSTRAP_PROMPT` frisch gestartet — die *mechanische*
  Queue ist davon unabhängig (deterministisch rekonstruierbar aus GitHub + `OWNERSHIP_MAP`).
- Stirbt der `MAIN_AGENT` (LLM) mitten in einer Urteilsfrage, fällt die Engine auf
  `EscalatedToHuman` zurück statt auf eine Vermutung — fail-safe in Richtung Mensch.

---

## 10. Offene Fragen (für den Review)

- **A1 — Mechanik-Hoheit des LLM:** Darf der `MAIN_AGENT` eigene `git rebase`/`git
  merge`-Mechanik fahren, oder strikt nur Konflikt-Hunks editieren, während die Engine
  alle git-Aufrufe macht? (Empfehlung: Engine fährt git, LLM editiert nur Hunks; via CI
  verifiziert.)
- **B1 — Schreibrecht auf Koordinations-Artefakte:** Schreibt ausschließlich der
  Integrator in Append-Dateien (`BACKLOG.md`, ADR-Index, `OWNERSHIP_MAP`), oder dürfen
  Sub-Agents direkt anhängen? (Empfehlung: Single-Owner Integrator, um textuelle
  Append-Konflikte aus paix §8 zu vermeiden.)
- **C1 — Schwellen/Intervalle:** Konkrete Werte für `STALE_THRESHOLD`,
  Rebase-Reminder-Frequenz, „main heiß"-Heuristik und Cron-Intervalle — empirisch zu
  kalibrieren (paix nennt nur „≥1×/Tag, mehr wenn heiß").
- **C2 — Integrator-Self-Approval:** Darf der Integrator selbst `reviewDecision=APPROVED`
  setzen (Solo-Maintainer-Fall), oder muss immer ein *menschliches* Approval vorliegen?
  Das berührt Branch-Protection-Policy (`[[github-multiagent]]` §2) und das „Mensch ist das Gate" aus
  paix Zeile 120. (Empfehlung: konfigurierbar; Default = menschliches Approval.)
- **C3 — Merge-Queue-Übergang:** Ab welchem racing-PR-Druck schaltet mads von manueller
  Serialisierung (`MergeRunner`-Schleife) auf die native GitHub-Merge-Queue um, und
  automatisiert mads deren (noch nicht sauber REST-fähige) Aktivierung? (paix/[[github-multiagent]]:
  „ab ≥2 racing PRs/h"; GraphQL-Mutationsname UNVERIFIZIERT.)
- **C4 — `effort`/Modellwahl Integrator:** `claude-opus-4-8` für Urteilsfragen ist
  gesetzt; offen, ob teure Klassifikations-Calls auf `sonnet` heruntergestuft werden für
  Kostenkontrolle bei vielen parallelen Konflikten.
