# Auftrag: Automatischer Account-Failover in MADS

Dieser Text ist als Prompt für die Claude-Code-Instanz gedacht, die MADS
(`<repo>`) pflegt. Bitte vollständig lesen, bevor Code
entsteht.

---

## 1. Ziel

MADS startet Claude-Code-Prozesse. Es gibt zwei bezahlte Claude-Max-Accounts.
Sobald der aktive Account sein 5-Stunden- oder Wochenlimit erreicht, soll MADS
selbstständig auf den anderen Account wechseln und die unterbrochene Aufgabe
dort fortsetzen — ohne Kontextverlust und ohne manuelles Eingreifen.

---

## 2. Gesicherter Stand (auf diesem Mac bereits eingerichtet und verifiziert)

| Profil | Account | Config-Verzeichnis |
|---|---|---|
| `haupt` | konto-a@example.com | `~/.claude` |
| `zweit` | konto-b@example.com | `~/.claude-zweit` |

* Die Umgebungsvariable `CLAUDE_CONFIG_DIR` wählt pro Prozess den Account.
* Beide Accounts sind **gleichzeitig** angemeldet. macOS legt den Schlüsselbund-
  Eintrag pro Config-Verzeichnis an (`Claude Code-credentials-<sha256(dir)[:8]>`),
  deshalb überschreiben sie sich nicht.
* `~/.claude-zweit/projects` ist ein Symlink auf `~/.claude/projects`. Beide
  Profile sehen also **dieselben Transcripts** — `--resume <session-id>` und
  `--continue` funktionieren über den Profilwechsel hinweg. Das ist die
  technische Grundlage für den Failover ohne Kontextverlust.
* `~/.claude-zweit/settings.json` ist ebenfalls ein Symlink.
* **Nicht geteilt:** `.claude.json`. Darin stecken u.a. die benutzerweiten
  MCP-Server. Änderungen dort müssen in beiden Profilen gepflegt werden.
* In `~/.zshrc` existieren die Funktionen `claude-haupt` und `claude-zweit`.

## 3. Bekannte Grenzen (recherchiert, Stand August 2026)

* Es gibt **keine** dokumentierte, maschinenlesbare Abfrage des Restkontingents.
  `/usage` ist reines TUI, es existiert kein `claude usage`-Subcommand und kein
  JSON-Endpunkt.
* Claude Code hat **keinen** eingebauten Account-Failover. `fallbackModel` gilt
  nur für Überlast (529), nicht für Limits.
* `autoContinueAtUsageLimit` existiert, aber es **wartet blockierend** auf den
  Reset. Genau das wollen wir nicht — nicht darauf aufbauen, und in den von MADS
  gestarteten Sessions besser explizit deaktiviert lassen.
* Die exakte Fehlerausgabe bei Limit-Erschöpfung im Headless-/SDK-Betrieb ist
  **nicht dokumentiert**. Sie muss empirisch ermittelt werden — siehe Schritt 1.

---

## Schritt 1 — Erst messen, dann bauen

Stelle zuerst fest, wie MADS Claude Code überhaupt startet: als Subprozess
(`claude -p …`) oder über das Agent SDK. Danach ermittle **empirisch**, wie ein
erschöpftes Limit in genau diesem Pfad ankommt:

* Subprozess: `--output-format stream-json` mitschneiden, dazu stdout, stderr
  und den Exit-Code.
* SDK: das geworfene Fehlerobjekt vollständig serialisieren.

Halte das Ergebnis in `docs/account-failover.md` fest, mit echten Rohausgaben.

**Keine Muster hartcodieren, die nicht selbst beobachtet wurden.** Als Kandidaten
zum Abgleich (aus der interaktiven Oberfläche bzw. der API-Ebene):

```
You've hit your session limit · resets 3:45pm
You've hit your weekly limit · resets Mon 12:00am
You've hit your Opus limit · resets 3:45pm
rate_limit_error        (API-Ebene, HTTP 429)
```

Die Reset-Angabe ist menschenlesbar. Parse sie defensiv und rechne sie in einen
absoluten Zeitstempel in `Europe/Berlin` um. Lässt sie sich nicht parsen, setze
einen konservativen Default (5-Stunden-Fenster: +5 h; Wochenfenster: +24 h) und
protokolliere das als Warnung.

Baue die Erkennung als **eine** Funktion mit einer Mustertabelle, die ohne
Codeänderung erweiterbar ist. Anthropic kann diese Texte jederzeit ändern.

## Schritt 2 — Profil-Registry

Eine Konfigurationsdatei, z.B. `~/.mads/accounts.json`:

```json
{
  "active": "haupt",
  "profiles": [
    { "id": "haupt", "label": "Konto A", "configDir": "~/.claude",         "color": "blue"  },
    { "id": "zweit", "label": "Konto B",     "configDir": "~/.claude-zweit",  "color": "green" }
  ],
  "cooldownUntil": { "haupt": null, "zweit": null }
}
```

Jeder von MADS gestartete Claude-Code-Prozess erbt:

* `CLAUDE_CONFIG_DIR` = `configDir` des aktiven Profils
* **entfernt**: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`

Diese drei Variablen haben höhere Priorität als die Anmeldung und würden den
Profilwechsel wirkungslos machen.

## Schritt 3 — Failover-Logik

Bei erkanntem Limit:

1. `cooldownUntil[aktuellesProfil]` auf den ermittelten Reset-Zeitpunkt setzen.
2. Das Profil mit abgelaufenem oder leerem Cooldown wählen. Bei mehreren: das mit
   dem längsten ungenutzten Zeitraum.
3. Ist **kein** Profil verfügbar: nicht pollen, nicht in einer Schleife laufen.
   Stattdessen den Auftrag pausieren, den frühesten Reset-Zeitpunkt anzeigen und
   einen Timer auf diesen Zeitpunkt setzen.
4. Aufgabe auf dem neuen Profil fortsetzen: gleiches Arbeitsverzeichnis,
   `--resume <session-id>`. MADS kennt die Session-ID, weil es den Prozess selbst
   gestartet hat — sie aus der ersten `stream-json`-Zeile mitschreiben.
5. Ereignis ins MADS-Log und als Meldung in die Oberfläche.
6. Idempotent halten: mehrere Limit-Meldungen aus demselben Lauf dürfen nur
   **einen** Wechsel auslösen.

Nach einem abgelaufenen Cooldown das Profil wieder als verfügbar markieren. Nicht
automatisch zurückwechseln, solange der aktuelle Account läuft — unnötige Wechsel
kosten Kontext.

## Schritt 4 — Oberfläche

* Dauerhaft sichtbar: welcher Account pro Agent gerade aktiv ist.
* Manueller Umschalter, der dieselbe Registry benutzt wie der Automatismus.
* Cooldown-Status je Profil mit Reset-Zeitpunkt.
* Beim automatischen Wechsel eine unaufdringliche Meldung, kein Modal.

## Schritt 5 — Ausdrücklich nicht tun

* **Kein** `CLAUDE_CODE_OAUTH_TOKEN`. Es gibt einen offenen Bug, bei dem dadurch
  der macOS-Schlüsselbund-Eintrag beim Beenden gelöscht wird
  (anthropics/claude-code#37512). Das würde den anderen Account aussperren.
* Keine Anmeldedaten zwischen Rechnern kopieren oder synchronisieren.
  Refresh-Tokens rotieren bei jeder Verwendung.
* Nicht in das Config-Verzeichnis eines Profils schreiben, während ein Prozess
  dieses Profils läuft — Claude Code schreibt `.claude.json` beim Beenden zurück.
* Zwei Prozesse dürfen **nicht** dieselbe Session-ID gleichzeitig fortsetzen.
  Die Transcripts sind über den Symlink geteilt und würden ineinanderlaufen.

## Schritt 6 — Abnahme

1. Zwei MADS-Agenten parallel starten, einen je Profil. Beide müssen ohne
   Schlüsselbund-Konflikt und ohne Neuanmeldung laufen.
2. Erkennungsfunktion mit den mitgeschnittenen Rohausgaben aus Schritt 1
   als Unit-Test abdecken, inklusive der Reset-Zeit-Parser.
3. Wechsel manuell auslösen und prüfen, dass die Aufgabe im selben Gespräch
   weiterläuft (Kontext aus vorherigen Turns muss vorhanden sein).
4. Verhalten prüfen, wenn beide Profile im Cooldown sind: sauberes Pausieren,
   keine Endlosschleife, korrekter Timer.
5. Erst danach unter echter Last testen — im laufenden Projekt
   `<ein-projekt>`.

---

## Randnotiz zur Wartung

Die benutzerweiten MCP-Server liegen in `.claude.json` und sind pro Profil
getrennt. Wenn MADS ohnehin Konfiguration verwaltet, wäre ein kleiner Befehl
sinnvoll, der den `mcpServers`-Block vom einen Profil ins andere spiegelt —
ausgeführt nur, wenn kein Claude-Code-Prozess läuft.
