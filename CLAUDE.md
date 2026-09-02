# CLAUDE.md — mads

Projekt-Brief für Claude-Code-Agenten, die an **mads** arbeiten. (Mensch-besessen —
Agenten *lesen* diese Datei, schreiben sie nicht um.)

## Was mads ist

Native macOS-Desktop-App (Tauri 2) für Multi-Agent-Entwicklung mit Claude Code:
ein Main-Agent (Integrator) + N Sub-Agents, je eigener Worktree/Branch, volle GitHub-Nutzung.
Vollständiges Design in `docs/design/` (Start: `docs/design/README.md`).

## Schichten (Verantwortungsgrenzen einhalten)

- **`src/`** — React/TS-Frontend. Reines UI: rendert State, sendet User-Intent. **Keine**
  Prozesse, **keine** Secrets, **keine** git/gh-Ausführung.
- **`src-tauri/`** — Rust-Core. Owner aller Child-Prozesse, IPC, Secrets, Persistenz.
  Bleibt „dünn": parst das NDJSON-Protokoll **nicht**, forwarded rohe Zeilen.
- **`sidecar/`** — Node-Orchestrator + Claude Agent SDK. Agenten-Pool, Worktrees, GitHub.
  **stdout ist nur NDJSON** — niemals `console.log` auf stdout; Logs via `log()` (stderr).
- **`shared/protocol.ts`** — die Single Source of Truth der Nachrichten-Typen. Änderungen
  hier betreffen Frontend **und** Sidecar; beide Seiten konsistent halten.

## Kern-Invarianten (nie brechen — siehe docs/research/_paix-multi-agent-reference.md)

1. **Nur der Integrator merged** nach `main`. Sub-Agents schlagen PRs vor, mergen nie selbst.
2. **`main` immer lauffähig** — Merge nur bei grünem, deterministischem (frozen-lockfile) CI.
3. **Ein Worktree pro Sub-Stream**, außerhalb des Repos unter `~/mads-worktrees/<repo-slug>/<agentId>`.
   Nie zwei Agenten im selben Working-Tree.
4. **Außen-sichtbare Aktionen** (push, pr create/merge) sind explizit — Permission/Anweisung.
5. **Single Source of Truth** für Agenten-State: Sidecar-Pool (Laufzeit), `agents.json` (Resume),
   SQLite (Audit). Der Core/Frontend spiegelt nur.

## Build & Gates

```bash
npm install && npm run sidecar:install
npm run sidecar:build          # esbuild -> sidecar/dist/index.js
npm run build                  # tsc + vite (Frontend + shared typecheck)
npm --prefix sidecar run typecheck
cargo build --locked --manifest-path src-tauri/Cargo.toml
npm run tauri dev              # App starten
```

Vor jedem PR: Frozen-Install + lint/typecheck/test über alle drei Schichten grün
(zwei Lockfile-Achsen: `package-lock.json` JS, `Cargo.lock` Rust). Lockfile-Bumps =
geteilter Datei-Edit → paix-Shared-File-Protokoll (land-first oder single-owner).

## Aktuelle Modelle

Rollen-Tiers: Integrator = stärkstes Coding-Modell, Sub-Agents = ausgewogen (günstiger),
Hilfs-/Explore = schnell & günstig. Die **exakten Model-IDs stehen im Code** (Single Source of
Truth — hier nicht hartcodieren, sonst driftet es): `shared/protocol.ts` → `DEFAULT_MODEL`
(Integrator-Default, aktuell `claude-opus-5`); `src/modelCatalog.ts` → wählbarer Katalog + Effort;
Sub-Agent-Default im Sidecar (`sidecar/src/orchestrator.ts`).
Model-IDs exakt verwenden (keine Datums-Suffixe außer dokumentiert).

## Offene Entscheidungen

Konsolidiert in `docs/design/README.md` → „Offene Entscheidungen". Bewusst offen (mit Default):
Anthropic-Auth-Lizenz (OE-6), Integrator-Self-Approval (OE-16, Default: menschliches Approval),
Auto-Issue-Erstellung (OE-29, Default: Human-in-the-Loop).
