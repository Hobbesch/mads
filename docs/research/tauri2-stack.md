# Tauri 2 — Stack-Recherche für mads

> Recherche-Stand: 2026-06-19. Quellen: Context7 (`/websites/tauri_app`), offizielle Tauri-Doku (`v2.tauri.app`), GitHub `tauri-apps`. Aktuelle stabile CLI zum Recherchezeitpunkt: **`@tauri-apps/cli` / `tauri-cli` 2.10.x** (Tauri-Core 2.x stabil). Versionsangaben ohne direkten Doku-Beleg sind als **UNVERIFIZIERT** markiert.

Dieses Dokument ist die Grundlage für die mads-Architektur: native macOS-App (Tauri 2 + React/TS), Node-Sidecar mit dem offiziellen Claude Agent SDK, ein Main-Agent (Integrator) + Sub-Agents 1..N, jeder auf eigener Git-Branch im eigenen Worktree.

---

## 0. TL;DR / Architektur-Empfehlungen für mads

| Frage | Empfehlung | Begründung |
|---|---|---|
| IPC für hochfrequente Terminal-Streams (stream-json je Agent) | **`tauri::ipc::Channel`** (eine Channel pro Agent) | Geordnete Zustellung, hoher Durchsatz, intern für Prozess-Output/Streaming gebaut. Events sind NICHT für High-Throughput/Low-Latency ausgelegt. |
| Sidecar vs. CLI direkt | **Node-Sidecar** (Claude Agent SDK ist Node) ist der sauberste Weg; spawnen **aus Rust** via `tauri_plugin_shell` + `spawn()` + `CommandEvent`, nicht aus dem Frontend | Rust-Core bleibt Owner aller Child-Prozesse → sauberes Lifecycle-Management, ein Channel pro Agent, keine Permission-Last im Webview. |
| Multi-Window ("jeder Sub-Agent ein Fenster") | `WebviewWindowBuilder` (Rust) bzw. `WebviewWindow` (JS), eindeutige **Labels** je Agent | Programmatisch erzeugbar, per Label adressierbar, `emit_to(label, ...)` für gezielte Streams. |
| Persistenz | `tauri-plugin-store` (Settings/State), `tauri-plugin-sql` (Agent-/Run-Historie) | Store für KV, SQL (sqlx + SQLite) für strukturierte Daten. |
| Distribution | Developer ID Application Cert + Notarization; **`externalBin` muss separat signiert/gehärtet werden** | Bekannter Stolperstein bei Sidecars (siehe Caveats). |
| Frontend | Vite + React + TS + **xterm.js** | xterm.js läuft problemlos im Webview; Output kommt per Channel vom Rust-Core. |

---

## 1. Voraussetzungen auf macOS & Projektstruktur

### 1.1 Prerequisites (macOS, Desktop-only)

```bash
# Xcode Command Line Tools (liefert clang, ld etc.)
xcode-select --install

# Rust toolchain via rustup
curl --proto '=https' --tlsv1.2 https://sh.rustup.rs -sSf | sh

# Node.js LTS (für Frontend-Build + Node-Sidecar)
# von nodejs.org installieren, dann prüfen:
node -v
npm -v
```
Quelle: <https://v2.tauri.app/start/prerequisites/>. Updater-Plugin verlangt Rust **>= 1.77.2**; `host-tuple`-Trick für Target-Triple braucht Rust >= 1.84.0 (sonst Fallback, s. Sidecar).

### 1.2 Projekt anlegen

```bash
# pnpm (oder npm / yarn / bun / cargo)
pnpm create tauri-app
# Interaktiv: Frontend = React/TS, Package-Manager etc.
```
Quelle: create-tauri-app, <https://v2.tauri.app/start/>.

### 1.3 Struktur

```
mads/
├─ src/                      # React/TS Frontend (Vite)
├─ src-tauri/
│  ├─ src/
│  │  ├─ lib.rs              # pub fn run() – Builder, Plugins, Commands
│  │  └─ main.rs             # ruft app_lib::run()
│  ├─ binaries/             # externalBin: node-sidecar-<target-triple>
│  ├─ capabilities/
│  │  └─ default.json        # Permissions je Window
│  ├─ icons/
│  ├─ tauri.conf.json        # App-Config, bundle, security/CSP
│  ├─ Cargo.toml
│  └─ build.rs
├─ sidecar/                  # Node-App (Claude Agent SDK) → zu Binary kompiliert
└─ package.json
```
Der Rust-Core wird auf macOS über den `#[cfg_attr(mobile, tauri::mobile_entry_point)] pub fn run()`-Einstieg in `lib.rs` gestartet.

---

## 2. Sidecar / External Binaries (Node Agent SDK)

### 2.1 Node-App zu Single-Binary kompilieren

Die offizielle Anleitung nutzt `@yao-pkg/pkg` (gepflegter Fork von vercel/pkg):

```bash
cd sidecar
npm add @yao-pkg/pkg --save-dev
```

`package.json`:
```json
{ "scripts": { "build": "pkg index.js --output node-sidecar" } }
```

> **mads-Hinweis:** Das Claude Agent SDK kann native Abhängigkeiten / dynamische Requires mitbringen. `pkg`/`@yao-pkg/pkg` snapshottet nur das JS-Bundle; assets/native Module müssen ggf. explizit eingebunden oder daneben gebündelt werden. Alternativ Node-Runtime separat bündeln und `node bundle.js` als Command starten. → **Caveat, vor Implementierung verifizieren.**

### 2.2 Target-Triple-Benennung (Pflicht!)

Tauri erwartet `<name>-<target-triple>[.exe]`. Beispiel `rename.js`:

```javascript
import { execSync } from 'child_process';
import fs from 'fs';

const ext = process.platform === 'win32' ? '.exe' : '';
// Rust >= 1.84.0:
const targetTriple = execSync('rustc --print host-tuple').toString().trim();
// Rust < 1.84.0 (Fallback):
// const targetTriple = /host: (\S+)/g.exec(execSync('rustc -vV').toString())[1];

fs.renameSync(
  `node-sidecar${ext}`,
  `../src-tauri/binaries/node-sidecar-${targetTriple}${ext}`
);
```
Auf Apple Silicon ergibt das z. B. `node-sidecar-aarch64-apple-darwin`. Quelle: <https://v2.tauri.app/learn/sidecar-nodejs/>.

### 2.3 Bündeln via `tauri.conf.json`

```json
{
  "bundle": {
    "externalBin": ["binaries/node-sidecar"]
  }
}
```
Aufruf erfolgt **ohne** Triple-Suffix — Tauri hängt es zur Build-Zeit automatisch an. Quelle: <https://v2.tauri.app/develop/sidecar/>.

### 2.4 Capabilities/Permissions für den Sidecar

`src-tauri/capabilities/default.json`:
```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Capability for the main window",
  "windows": ["main"],
  "permissions": [
    "core:default",
    {
      "identifier": "shell:allow-execute",
      "allow": [
        { "name": "binaries/node-sidecar", "sidecar": true, "args": true }
      ]
    }
  ]
}
```
- `"args": true` erlaubt beliebige Argumente; sicherer ist eine Whitelist mit Validatoren:
```json
"args": ["--agent", { "validator": "\\S+" }]
```
- Wird der Sidecar **aus Rust** gespawnt, braucht das **Frontend keine** `shell`-Permission (s. u.). Das ist für mads die saubere Variante.
Quellen: <https://v2.tauri.app/develop/sidecar/>, <https://v2.tauri.app/learn/sidecar-nodejs/>.

### 2.5 Starten + Streaming aus **Rust** (empfohlen für mads)

```rust
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;
use tauri::ipc::Channel;
use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
enum AgentOutput {
    Stdout { line: String },
    Stderr { line: String },
    Terminated { code: Option<i32> },
}

#[tauri::command]
async fn start_agent(
    app: tauri::AppHandle,
    agent_id: String,
    args: Vec<String>,
    on_event: Channel<AgentOutput>, // eine Channel je Agent, vom Frontend übergeben
) -> Result<(), String> {
    let sidecar = app.shell()
        .sidecar("node-sidecar").map_err(|e| e.to_string())?
        .args(args);

    let (mut rx, mut child) = sidecar.spawn().map_err(|e| e.to_string())?;

    // child ggf. in tauri::State ablegen, um später stdin zu schreiben / zu killen
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes).to_string();
                    let _ = on_event.send(AgentOutput::Stdout { line });
                }
                CommandEvent::Stderr(bytes) => {
                    let line = String::from_utf8_lossy(&bytes).to_string();
                    let _ = on_event.send(AgentOutput::Stderr { line });
                }
                CommandEvent::Terminated(payload) => {
                    let _ = on_event.send(AgentOutput::Terminated { code: payload.code });
                    break;
                }
                _ => {}
            }
        }
    });

    // Beispiel: in stdin schreiben (z. B. Prompt an Agent senden)
    // child.write("hello from rust\n".as_bytes()).unwrap();
    Ok(())
}
```
`CommandEvent`-Varianten: `Stdout(Vec<u8>)`, `Stderr(Vec<u8>)`, `Terminated(TerminatedPayload { code, signal })`, `Error(String)`. `child.write(&[u8])` schreibt auf stdin; `child.kill()` beendet. Quelle: <https://v2.tauri.app/develop/sidecar/>.

> **Wichtig für stream-json:** Der Claude-Code-/Agent-SDK-Output kommt als JSON-Lines. `CommandEvent::Stdout` liefert standardmäßig **zeilenweise** (newline-delimited) — passt gut. Bei sehr langen Zeilen ohne Newline ggf. eigenes Buffering. → **verifizieren** mit echtem SDK-Output.

### 2.6 Alternativ: Starten aus dem **Frontend** (JS)

```javascript
import { Command } from '@tauri-apps/plugin-shell';

const command = Command.sidecar('binaries/node-sidecar', ['--agent', agentId]);
command.stdout.on('data', line => console.log('stdout:', line));
command.stderr.on('data', line => console.error('stderr:', line));
command.on('close', d => console.log(`closed code=${d.code} signal=${d.signal}`));
command.on('error', err => console.error('error:', err));
const child = await command.spawn();
console.log('pid:', child.pid);
// child.write('...'); child.kill();

// Einmalig (blockierend bis Ende):
// const output = await Command.sidecar('binaries/node-sidecar', ['hello']).execute();
// console.log(output.stdout);
```
Quellen: <https://v2.tauri.app/reference/javascript/shell/>, <https://v2.tauri.app/develop/sidecar/>.

> **Empfehlung mads:** Rust-Pfad (2.5) bevorzugen — zentrales Prozess-Lifecycle, keine `shell`-Permission im Webview, ein Channel pro Agent direkt aus dem Command-Handler. Der JS-Pfad fragmentiert das Lifecycle über mehrere Fenster.

---

## 3. IPC: Commands, Events, Channels

### 3.1 Commands (`#[tauri::command]` + `invoke`)

```rust
#[tauri::command]
fn greet(name: &str) -> String { format!("Hello, {name}!") }

// Registrierung
tauri::Builder::default()
  .invoke_handler(tauri::generate_handler![greet, start_agent])
```
```javascript
import { invoke } from '@tauri-apps/api/core';
const msg = await invoke('greet', { name: 'mads' });
```
Async-Commands (`async fn` / `-> Result<T, E>`) laufen ohne UI-Block. Quelle: <https://v2.tauri.app/develop/calling-rust/>.

### 3.2 Events (emit/listen) — für seltene, kleine Nachrichten

```rust
use tauri::{Emitter, Manager};
app.emit("download-started", &url).unwrap();          // an alle
app.emit_to("agent-3", "status", &payload).unwrap();  // an Fenster mit Label "agent-3"
```
```javascript
import { listen } from '@tauri-apps/api/event';
const unlisten = await listen('status', e => console.log(e.payload));
// unlisten() beim Unmount aufrufen
```
**Eigenschaften (laut Doku):** Payload immer JSON-String; **nicht** für Low-Latency/High-Throughput; bei async-Listenern und schneller Folge **keine Ordnungsgarantie**; gut für Multi-Consumer/Multi-Producer (Notifications, Status). Quelle: <https://v2.tauri.app/develop/calling-frontend/>.

### 3.3 Channels (`tauri::ipc::Channel`) — für mads' Terminal-Streams

```rust
use tauri::ipc::Channel;

#[tauri::command]
fn download(on_event: Channel<MyEvent>) {
    on_event.send(MyEvent::Progress { chunk: 1024 }).unwrap();
}
```
```javascript
import { invoke, Channel } from '@tauri-apps/api/core';
const onEvent = new Channel();
onEvent.onmessage = (m) => console.log(m); // geordnet
await invoke('download', { onEvent });
```
**Eigenschaften:** schnell, **geordnet**, volle Serde-Serialisierung; intern für Streaming (Download-Progress, **Child-Process-Output**, WebSocket) verwendet. Quelle: <https://v2.tauri.app/develop/calling-frontend/>.

### 3.4 Vergleich & Entscheidung

| Aspekt | Events | **Channels** |
|---|---|---|
| Typisierung | nur JSON-Strings | volle Serde-Serialisierung |
| Durchsatz | niedrig, kleine Daten | **hoch (Streaming)** |
| Ordnung | bei async nicht garantiert | **garantiert geordnet** |
| Konsumenten | Multi-Consumer/Producer | i. d. R. ein Handler |
| Latenz | nicht optimiert | **auf Speed ausgelegt** |
| Use-Case mads | Agent-Status, Lifecycle-Notifications | **stream-json Terminal-Output je Agent** |

**Pattern für mads:** Pro Agent eine `Channel<AgentOutput>` beim Start übergeben (3.2.5). Für aggregierte/seltene Signale (Agent fertig, Fehlerbanner, Branch-Update) Events oder `emit_to(label,...)`.

> **Multi-Window-Caveat:** Eine `Channel` ist an den Webview-Kontext gebunden, von dem aus `invoke` kam. Soll der Output in einem **anderen** Fenster landen (z. B. Agent läuft in Fenster X, Übersicht in Fenster Main), entweder dort `invoke` aufrufen oder zusätzlich `emit_to(label,...)` nutzen. → Architektur früh festlegen.

---

## 4. Multi-Window (ein Fenster je Sub-Agent)

### 4.1 Fenster programmatisch erzeugen — Rust

```rust
use tauri::{WebviewWindowBuilder, WebviewUrl};

let label = format!("agent-{agent_id}");
let win = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("agent.html".into()))
    .title(format!("Agent {agent_id}"))
    .inner_size(900.0, 600.0)
    .build()?;
```

### 4.2 Fenster — JS

```javascript
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
const w = new WebviewWindow(`agent-${id}`, { url: 'agent.html', title: `Agent ${id}` });
w.once('tauri://created', () => {/* ok */});
w.once('tauri://error', e => {/* fehler */});
```

### 4.3 Fenster verwalten / adressieren

```rust
use tauri::Manager;
if let Some(w) = app.get_webview_window("agent-3") { let _ = w.set_focus(); }
for w in app.webview_windows().values() { /* iterate */ }
```
```javascript
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
const w = await WebviewWindow.getByLabel('agent-3');
```

### 4.4 Fenster-Kommunikation

- Backend → bestimmtes Fenster: `app.emit_to("agent-3", "event", payload)`.
- Fenster → Fenster: über den Rust-Core routen (Command empfangen, `emit_to` an Ziel) — sauberer als Webview↔Webview.
- Listener je Fenster: `WebviewWindow.getCurrent().listen('event', cb)`.

**Capabilities:** Jedes Fenster braucht ein passendes Capability (`"windows": ["agent-*"]` mit Wildcard möglich), sonst keine API-Rechte. Quellen: <https://v2.tauri.app/reference/javascript/api/namespacewebviewwindow>, <https://v2.tauri.app/learn/window-customization/>.

> **Performance-Caveat (mads):** Jedes `WebviewWindow` ist eine eigene WKWebView-Instanz (RAM/GPU). Bei vielen gleichzeitigen Agents kann „1 Fenster pro Agent" teuer werden. Alternative: **ein Fenster, mehrere xterm.js-Panes/Tabs**, gespeist über mehrere Channels. → Skalierungsentscheidung früh treffen.

---

## 5. Security-Modell

- **Capabilities** (`src-tauri/capabilities/*.json|toml`): binden **Permissions** an **Fenster/Webviews** (per Label, Wildcards `*` erlaubt). Felder: `identifier`, `description`, `windows`, `permissions`, optional `platforms`, `remote`.
- **Core- vs. Plugin-Permissions:** `core:*` (path, event, window, app, resources, menu, tray) vs. Plugin-Permissions (`shell:*`, `store:*`, `notification:*` …). `core:default` ist eine sinnvolle Basis.
- **Scope:** Permissions wie `shell:allow-execute` werden über `allow`-Listen mit `name`/`sidecar`/`args`-Validatoren feingranular eingeschränkt.
- **Remote Capabilities:** `"remote": { "urls": ["https://*.tauri.app"] }` — nur falls Remote-Inhalte Commands aufrufen dürfen. Für mads i. d. R. **nicht** nötig (lokales Frontend).
- **CSP:** in `tauri.conf.json > app > security > csp` setzen; restriktiv halten (kein `unsafe-eval`/Remote, außer für xterm/WebGL nötig).
- **Isolation Pattern:** optionaler zusätzlicher Sandbox-iframe, der jede IPC-Nachricht vor dem Core abfängt/validiert — sinnvoll, wenn Drittinhalte gerendert werden.
- **Command-Restriction:** Default sind alle Commands für alle Fenster erreichbar; via `AppManifest::commands` in `build.rs` einschränkbar.

**Grenzen:** Capabilities schützen vor kompromittiertem Frontend / Privilege-Escalation, **nicht** vor bösartigem Rust-Code, Supply-Chain-Angriffen oder WebView-0-Days. Was ein **Sidecar** darf, bestimmt allein der OS-Prozess (Tauri sandboxt den Child-Prozess nicht) — der Sidecar läuft mit den Rechten der App. mads sollte dem Sidecar nur die nötigen FS-/Netz-Zugriffe geben (Git-Worktrees, GitHub-API). Quellen: <https://v2.tauri.app/security/capabilities/>, <https://v2.tauri.app/develop/sidecar/>.

---

## 6. State & Plugins

### 6.1 Rust-State (`tauri::State`)

```rust
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Default)]
struct AgentRegistry(Mutex<HashMap<String, /* Child / Handle */ String>>);

#[tauri::command]
fn list_agents(state: tauri::State<AgentRegistry>) -> Vec<String> {
    state.0.lock().unwrap().keys().cloned().collect()
}

tauri::Builder::default()
  .manage(AgentRegistry::default())
```
mads kann hier laufende `Child`-Handles je Agent halten (zum stdin-Schreiben/Killen). Quelle: <https://v2.tauri.app/develop/calling-rust/>.

### 6.2 Persistenz-Plugins

| Plugin | Zweck für mads | Hinweise |
|---|---|---|
| `tauri-plugin-store` | KV-Settings, UI-State, Fenster-Layout, zuletzt benutzte Repos | persistentes JSON; JS + Rust API |
| `tauri-plugin-sql` | Agent-/Run-Historie, Logs, Branch/PR-Metadaten | sqlx-basiert, SQLite empfohlen für lokale App |

Beide müssen **auf Rust- und JS-Seite** registriert werden (`.plugin(...)` + `@tauri-apps/plugin-*`). Quellen: <https://v2.tauri.app/plugin/store/>, <https://v2.tauri.app/plugin/sql/>.

### 6.3 macOS-Notifications

`tauri-plugin-notification` — z. B. „Agent 3 fertig / wartet auf Input / PR erstellt". Auf macOS native Notification Center Integration; Permission `notification:default`. Quelle: <https://v2.tauri.app/plugin/notification/>.

### 6.4 App-Updates

`tauri-plugin-updater` (kein Built-in-Flag mehr in v2). Verlangt Rust >= 1.77.2; nutzt signierte Update-Artefakte (eigenes Signing-Keypair zusätzlich zum Apple-Signing). Quellen: <https://v2.tauri.app/plugin/updater/>, <https://github.com/tauri-apps/tauri-plugin-updater>.

### 6.5 Tray & macOS-Menüleiste

```rust
use tauri::{menu::{Menu, MenuItem}, tray::TrayIconBuilder};

let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
let menu = Menu::with_items(app, &[&quit])?;
let _tray = TrayIconBuilder::new()
    .menu(&menu)
    .show_menu_on_left_click(true)
    .on_menu_event(|app, ev| if ev.id.as_ref() == "quit" { app.exit(0); })
    .build(app)?;
```
`Cargo.toml`: `tauri = { version = "2", features = ["tray-icon"] }`. App-Menü (obere macOS-Menüleiste) analog via `MenuBuilder`/`Menu`. Quelle: <https://v2.tauri.app/learn/system-tray/>.

---

## 7. Build, Signing & Notarization (macOS) — Überblick

1. **Cert:** „Developer ID Application"-Zertifikat (paid Apple Developer Account, $99/Jahr; Free-Tier kann **nicht** notarisieren). Ins Keychain importieren.
2. **Identity finden:** `security find-identity -v -p codesigning`.
3. **Config** `tauri.conf.json`:
```json
{
  "bundle": {
    "macOS": {
      "signingIdentity": "Developer ID Application: Name (TEAMID)",
      "entitlements": "./Entitlements.plist"
    }
  }
}
```
   oder Env `APPLE_SIGNING_IDENTITY`.
4. **CI-Env:** `APPLE_CERTIFICATE` (base64 .p12), `APPLE_CERTIFICATE_PASSWORD`, plus Notarization entweder
   - **App Store Connect API:** `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_PATH`, oder
   - **Apple-ID:** `APPLE_ID`, `APPLE_PASSWORD` (app-specific), `APPLE_TEAM_ID`.
   - `.p12` exportieren: `openssl base64 -A -in cert.p12 -out cert-base64.txt`.
5. **Build + Notarize:** `pnpm tauri build --bundles dmg` (Tauri signiert + notarisiert, wenn Env gesetzt). `--skip-stapling` für initiale Durchläufe.

Quellen: <https://v2.tauri.app/distribute/sign/macos/>, Suchergebnisse zu Signing-Guides.

> **Sidecar/externalBin-Caveat:** Es gibt einen bekannten Bug, dass `externalBin`/Sidecars bei Codesigning + Notarization Probleme machen (GitHub Issue #11992). Sidecars müssen mit **Hardened Runtime** und passenden **Entitlements** signiert werden, sonst schlägt die Notarization fehl bzw. Gatekeeper blockt. → **Früh in der CI testen**, Entitlements für JIT/Node (`com.apple.security.cs.allow-jit`, `allow-unsigned-executable-memory`) prüfen. Referenz: <https://github.com/tauri-apps/tauri/issues/11992>.

---

## 8. Frontend-Setup (Vite + React + TS + xterm.js)

- **Vite + React + TS** ist der von create-tauri-app unterstützte Standard; Dev-Server + HMR funktionieren mit `tauri dev`.
- **xterm.js** (heute `@xterm/xterm`): reines DOM/Canvas/WebGL-Terminal, läuft unverändert in der WKWebView. Output je Agent über die jeweilige `Channel.onmessage` → `term.write(line)`. Für stream-json: JSON je Zeile parsen, gerendert/gefiltert in xterm schreiben.
- Empfehlung: `@xterm/addon-fit` (Resize) + ggf. `@xterm/addon-webgl` (Performance bei viel Output). xterm-Input (User-Tastatur) → `child.write` via Command/stdin.

> **UNVERIFIZIERT (Trainingswissen):** xterm-Versionierung/Paketname (`@xterm/xterm` vs. altes `xterm`) und WebGL-Addon-Verhalten in WKWebView vor Implementierung gegen aktuelle xterm-Doku prüfen.

---

## 9. Wichtigste Caveats / offene Punkte (für Doku-Autoren)

1. **IPC-Pfad für viele hochfrequente Terminal-Streams:** `tauri::ipc::Channel` pro Agent ist die richtige Wahl (geordnet, high-throughput, intern für Child-Output gebaut) — **nicht** Events. Offen: Eine Channel ist an den aufrufenden Webview gebunden; bei Multi-Window muss klar definiert sein, wo `invoke` startet bzw. wann zusätzlich `emit_to(label,...)` gebraucht wird. Sehr lange Zeilen ohne Newline ggf. eigenes Buffering. Mit echtem stream-json-Output des Claude Agent SDK verifizieren.
2. **Sidecar-Strategie & Signing:** Node-Sidecar aus **Rust** spawnen ist am saubersten (Lifecycle im Core, keine Webview-Permission). Aber: (a) `@yao-pkg/pkg`-Bundling muss mit dem Claude Agent SDK (native Module / dynamische Requires) tatsächlich funktionieren — alternativ Node-Runtime daneben bündeln; (b) **externalBin braucht Hardened Runtime + Entitlements**, sonst scheitert macOS-Notarization (Issue #11992). Beides früh in einer echten signierten CI-Build prüfen.
3. **Multi-Window-Skalierung:** „1 WKWebView pro Sub-Agent" kostet bei vielen Agents spürbar RAM/GPU. Entscheiden: viele Fenster vs. ein Fenster mit mehreren xterm-Panes (mehrere Channels). Diese Architekturentscheidung beeinflusst Channel-Routing, Capabilities (Wildcard-Labels) und State-Layout und sollte vor dem Bau feststehen.

---

## 10. Quellen

- Prerequisites (macOS): <https://v2.tauri.app/start/prerequisites/>
- Get Started / create-tauri-app: <https://v2.tauri.app/start/>
- Sidecar (Embedding External Binaries): <https://v2.tauri.app/develop/sidecar/>
- Node.js als Sidecar: <https://v2.tauri.app/learn/sidecar-nodejs/>
- Shell-Plugin JS-API: <https://v2.tauri.app/reference/javascript/shell/> / <https://v2.tauri.app/plugin/shell/>
- Calling Rust from Frontend (Commands, State): <https://v2.tauri.app/develop/calling-rust/>
- Calling Frontend from Rust (Events vs. Channels): <https://v2.tauri.app/develop/calling-frontend/>
- Inter-Process Communication (Konzept): <https://v2.tauri.app/concept/inter-process-communication/>
- WebviewWindow JS-API: <https://v2.tauri.app/reference/javascript/api/namespacewebviewwindow>
- Window Customization (macOS): <https://v2.tauri.app/learn/window-customization/>
- Security / Capabilities: <https://v2.tauri.app/security/capabilities/>
- System Tray / Menü: <https://v2.tauri.app/learn/system-tray/>
- Store-Plugin: <https://v2.tauri.app/plugin/store/>
- SQL-Plugin: <https://v2.tauri.app/plugin/sql/>
- Notification-Plugin: <https://v2.tauri.app/plugin/notification/>
- Updater-Plugin: <https://v2.tauri.app/plugin/updater/> / <https://github.com/tauri-apps/tauri-plugin-updater>
- macOS Code Signing: <https://v2.tauri.app/distribute/sign/macos/>
- externalBin Notarization Bug: <https://github.com/tauri-apps/tauri/issues/11992>
- Tauri 2.0 Stable Blog: <https://v2.tauri.app/blog/tauri-20/>
- Plugins-Workspace (offizielle Plugins): <https://github.com/tauri-apps/plugins-workspace>
- Context7: `/websites/tauri_app` (Tauri Doku, High Reputation)
