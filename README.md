# mads — multi-agent development surface

Eine native **macOS-Desktop-App**, in der ein Mensch **parallel mit vielen
Claude-Code-Agenten** entwickelt: ein **Main-Agent (Integrator)** plus **Sub-Agents 1..N**,
jeder auf eigener Git-Branch im eigenen Worktree, mit voller GitHub-Nutzung — und einem
Dashboard, das jederzeit zeigt, **welcher Agent läuft, wer Input braucht und wo eine
Eskalation ansteht**.

> Status: **Design vollständig + lauffähiger Prototyp (P0–P2)**. Stand 2026-06-19.

---

## Warum mads

VS Code + Claude Code skaliert schlecht für echtes Multi-Agent-Arbeiten: man sieht nicht,
wie viele Prozesse laufen, wer gerade eine Frage stellt, und paralleles Arbeiten führt zu
GitHub-Konflikten. mads macht die bewährten Multi-Agent-Invarianten (aus
[`docs/research/_paix-multi-agent-reference.md`](docs/research/_paix-multi-agent-reference.md))
**mechanisch erzwingbar und im UI sichtbar**:

1. **Only `main` merges** — nur der Integrator landet auf `main`.
2. **`main` is always runnable** — jeder Merge passiert deterministisches, grünes CI.
3. **Subs never self-merge** — außen-sichtbare Aktionen brauchen explizite Anweisung.

## Architektur (4 Schichten)

```
React/TS-Frontend  ◄─Channel / invoke─►  Tauri Rust-Core  ◄─NDJSON/stdio─►  Node-Sidecar  ──Agent SDK──►  N Claude-Code-Agenten
   (Dashboard,                          (Prozess-Lifecycle,                (Orchestrator,                 (je eigener
    xterm, Dialoge)                      Secrets, IPC, Persistenz)          Claude Agent SDK)              Worktree + Branch)
                                                                                                          └──► Git/Worktrees + GitHub
```

Vollständiges Design in **[`docs/design/`](docs/design/README.md)**:

| # | Dokument | Inhalt |
|---|---|---|
| 01 | [Gesamtarchitektur](docs/design/01-architecture.md) | Schichten, Datenmodell, IPC, Sicherheit, Roadmap |
| 02 | [Dashboard](docs/design/02-dashboard.md) | Sidebar + Agent-Grid + Inspector, Live-Terminal, Input/Eskalation |
| 03 | [Main-Agent (Integrator)](docs/design/03-main-agent.md) | Merge-Prozedur, Gates, Cron-Jobs |
| 04 | [Sub-Agents](docs/design/04-sub-agents.md) | Lebenszyklus, Rückfragen, GitHub, Cleanup |
| 05 | [Update-Bereich](docs/design/05-update-area.md) | Claude-Code-Feature-Monitoring → GitHub-Issue-Vorschlag |
| 06 | [Region-Ownership & Koordination](docs/design/06-ownership-and-coordination.md) | Ownership auf Sub-Datei-Ebene + Trespass-Erkennung vor dem Merge |

Die Recherche-Grundlagen liegen in [`docs/research/`](docs/research/).

---

## Prototyp — was schon funktioniert

- **Rust-Core** spawnt den Node-Sidecar (`std::process`) und forwarded dessen stdout/stderr
  zeilenweise über einen `tauri::ipc::Channel` ans Frontend; stdin trägt die HostMessages.
- **Sidecar** orchestriert Agenten über das **Claude Agent SDK** (`query()`,
  Streaming-Input-Modus, `canUseTool`-Permission-Interception) — plus einen **Mock-Modus**,
  der das gesamte UI inkl. Permission-Loop ohne Claude-Login demonstriert.
- **Dashboard** (macOS-HIG-Stil): Sidebar mit Streams, Agent-Karten mit Status-Ampeln,
  „braucht Input"- und Eskalations-Hervorhebung, Live-Terminal (xterm.js) pro Agent,
  Permission-Dialog, Follow-up-Composer.

Noch nicht im Prototyp (Roadmap P3+): Worktree-Anlage, GitHub-Integration/Eskalations-
Polling, Integrator-Merge-Mechanik, Persistenz/Resume, Signing/Notarization, Update-Bereich.
Siehe [Roadmap](docs/design/01-architecture.md#10-roadmap--phasen-mvp--vollausbau).

---

## Entwicklung

### Voraussetzungen (macOS)

- **Xcode Command Line Tools** (`xcode-select --install`)
- **Rust** (stable, via [rustup](https://rustup.rs))
- **Node.js** ≥ 20 LTS
- Für reale Agenten: ein eingeloggtes **Claude Code** (macOS-Keychain) bzw.
  `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`). Ohne Auth den **Mock-Modus** nutzen.

### Setup & Start

```bash
npm install                 # Frontend-Deps
npm run sidecar:install     # Sidecar-Deps (Claude Agent SDK)
npm run sidecar:build       # Sidecar nach sidecar/dist/index.js bauen (PFLICHT vor dev)
npm run tauri dev           # App starten (Dev-Modus)
```

Im Dashboard **„+ Neuer Stream"** → Rolle + Aufgabe wählen. Ohne Claude-Login ist der
**Mock-Modus** vorausgewählt: ein scripted Agent läuft los, streamt Schritte und fragt
einmal nach Erlaubnis (Push) — so siehst du Live-Output, „braucht Input" und den
Permission-Dialog sofort.

> Der Rust-Core startet den Sidecar mit `node`. Wird die App nicht aus einer Shell mit
> `node` im `PATH` gestartet, setze `MADS_NODE=/pfad/zu/node`. Den Sidecar-Pfad kann
> `MADS_SIDECAR_JS` überschreiben.

### Repo-Struktur

```
src/            React/TS-Frontend (Dashboard, xterm, Dialoge, zustand-Store)
src-tauri/      Rust-Core (Sidecar-Supervisor, IPC-Commands)
sidecar/        Node-Orchestrator + Claude Agent SDK (NDJSON über stdio)
shared/         Geteilte TS-Typen: das Protokoll (Single Source of Truth)
docs/design/    Die sechs Design-Dokumente + Index
docs/research/  Recherche-Grundlagen (Claude Code, Tauri, GitHub, macOS-HIG)
```

## Lizenz

Siehe [LICENSE](LICENSE).
