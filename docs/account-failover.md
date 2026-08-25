# Mehrere Claude-Konten in mads

Stand: 2026-08-25. Ziel: Bei erschöpftem Kontingent eines Claude-Max-Abos auf ein zweites
Konto wechseln können, **ohne den laufenden Auftrag zu verlieren**.

## Entscheidung: warnen, nicht automatisch wechseln

mads wechselt das Konto **nicht von selbst**. Grund: Ein Wechsel startet den Claude-Prozess neu
(`CLAUDE_CONFIG_DIR` steht beim Spawn fest und ist danach unveränderlich). Das mitten in laufender
Arbeit ohne Rückfrage zu tun, ist ein Eingriff, der eine bewusste Entscheidung verdient.

Stattdessen: mads erkennt das Limit, hält den Cooldown fest, meldet es im Stream-Verlauf und bietet
den Umschalter an. Der Klick löst den Wechsel aus.

## Wie die Erkennung funktioniert — ohne Textparsing

Primär durch die **aktive Usage-Abfrage** (siehe nächster Abschnitt), ergänzend durch das
Ereignis `rate_limit_event`. Beides ist **maschinenlesbar** — kein Fehlertext wird geparst.

Das Ereignis (`sidecar/src/session.ts` → `onRateLimit()`), bis dahin ignoriert (`default: break;`):

```
rate_limit_info {
  status:        "allowed" | "allowed_warning" | "rejected"
  rateLimitType: "five_hour" | "seven_day" | …
  resetsAt:      Zeitstempel
  utilization:   0..1
}
```

**Es ist keine Mustertabelle für Fehlertexte nötig.** Ein früherer Entwurf sah vor, Meldungen
wie `"You've hit your session limit · resets 3:45pm"` zu parsen und die Uhrzeit defensiv in eine
Zeitzone umzurechnen. Das wäre unnötig fragil gewesen: Anthropic kann diese Texte jederzeit ändern,
`resetsAt` dagegen kommt strukturiert.

Robustheit trotzdem eingebaut:

* `toEpochMs()` akzeptiert Sekunden-Epoche, Millisekunden-Epoche und ISO-String und verwirft
  Unplausibles (Fenster: jetzt−1 h bis jetzt+30 Tage). Unbekannt → die UI zeigt „Reset unbekannt"
  statt einer erfundenen Zeit.
* Unbekannte Fehler im Consume-Pfad werden jetzt mit `describeError()` **roh** geloggt
  (`name`, `message`, `status`, `code`, Stack-Auszug). Vorher ging über `String(e)` genau das
  verloren, woran sich ein Kontingent- von einem Transportfehler unterscheiden lässt. Falls ein
  Limit doch anders ankommt als über `rate_limit_event`, steht es damit im Log.
* Wiederholte Events desselben Fensters werden entprellt (`lastRateLimitKey`).

## Verifiziert am 2026-08-25: die Usage-Abfrage trägt, das Ereignis nicht

Gegen die echten Konten gemessen (minimaler Haiku-Turn, Usage-API abgefragt):

| Konto | `five_hour` | `seven_day` |
|---|---|---|
| power-blox | 11 % (Reset 11:59) | **100 %** (Reset Mi. 15:59) |
| medici | 2 % | 0 % |

Deckungsgleich mit den „Plan-Nutzungslimits" in den Claude-Apps.

**Zwei Korrekturen an früheren Annahmen:**

1. **`rate_limit_event` kam in keinem der Testläufe.** Die Annahme, das Ereignis liefere den
   laufenden Verbrauch, trägt nicht — es feuert offenbar nur in Sondersituationen (wenn überhaupt).
   Die aktive Abfrage `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` ist deshalb der
   PRIMÄRE Weg; das Ereignis bleibt nur als Ergänzung für den Cooldown erhalten.
2. **Die Antwort enthält mehr als die Typdefinition zeigt.** Neben `five_hour`/`seven_day`
   (`utilization` als PROZENT 0–100, `resets_at` als ISO-String) liefert sie ein `limits`-Array mit
   `kind`/`group`/`percent`/`severity`/`scope` sowie zahlreiche Felder unter Codenamen. mads liest
   bewusst nur die beiden dokumentierten Fenster — die übrigen sind unbenannt und könnten sich
   jederzeit ändern.

**Grenze:** Die Abfrage braucht eine laufende Sitzung. Ein Konto, auf dem gerade kein Stream läuft,
lässt sich nicht abfragen — es gibt keinen CLI-Unterbefehl dafür (`claude usage` existiert nicht).
Der Wert erscheint deshalb, sobald ein Stream auf dem Konto seinen ersten Turn beginnt.

## Wo man den Verbrauch sieht

Im Kopf des Streams, in der Auswahl **KONTO**:

* Laufend: `power-blox — 100% verbraucht` (schlimmstes der Fenster) plus Balken fuer 5 Std. und Woche,
  gespeist aus der Usage-Abfrage nach jedem Turn.
* Bei Vorwarnung/Anschlag zusätzlich eine Meldung im Verlauf mit Reset-Uhrzeit und, falls ein Konto
  frei ist, dem Hinweis aufs Umschalten.
* Im Cooldown ersetzt `— Limit bis 15:40` die Prozentanzeige.

Der Verbrauch liegt **nur im Speicher** (`store.accountUsage`), nicht in der Registry: es ist eine
Momentaufnahme, die nach einem Neustart ohnehin veraltet wäre, und `accounts.json` soll nicht bei
jedem Prozentpunkt neu geschrieben werden.

Sichtbar wird der Wert erst, **nachdem** ein Stream mindestens einen Turn auf dem Konto gelaufen
ist — vorher hat das SDK noch nichts gemeldet. Für ein Konto, das gerade nicht benutzt wird, gibt
es folglich keine Anzeige; es gibt keine Abfrage des Kontingents ohne laufende Sitzung.

## Registry: `~/.mads/accounts.json`

Bewusst **benutzerweit**, nicht projektlokal wie der übrige Sidecar-State: Kontingente gelten pro
Konto global. Läge die Datei im Repo, hätte jedes Projekt eigene Cooldowns — also falsch.

```json
{
  "v": 1,
  "activeId": "pbx",
  "profiles": [
    { "id": "pbx", "label": "power-blox", "configDir": "/Users/amedici/.claude" },
    { "id": "med", "label": "medici",     "configDir": "/Users/amedici/.claude-medici" }
  ],
  "cooldowns": {}
}
```

* `configDir` darf `~/...` enthalten (wird aufgelöst).
* Die E-Mail wird **nicht** gespeichert, sondern bei jedem Laden aus der `.claude.json` des Kontos
  gelesen — sonst veraltete sie nach einer Neuanmeldung still.
  Fundort unterscheidet sich: bei gesetztem `CLAUDE_CONFIG_DIR` liegt sie **im** Verzeichnis, im
  Standardfall (`~/.claude`) **daneben** als `~/.claude.json`. Beides wird geprüft.
* Kaputte/fehlende Datei → Standardkonto, nie ein harter Fehler.
* Abgelaufene Cooldowns werden beim Laden verworfen.

## Was beim Wechsel passiert

`orchestrator.ts` → `setAccount()`:

1. Dev-Server des Streams beenden (hängt am alten Prozess).
2. Session stoppen — **Worktree behalten** (`stop(false)`), die Arbeit soll weiterlaufen.
3. Neue Session im Zielkonto starten mit `resumeSessionId` + `resumeWorktreePath`,
   `continuation: true` (kein neuer Auftrag, `lastPrompt` bleibt erhalten).

Ohne `sessionId` wird der Wechsel **abgelehnt** statt still den Verlauf wegzuwerfen — der Stream
meldet `account_switch_failed`.

## Zwei Fallen, die dabei geschlossen wurden

**1. `claudeSessionExists()` prüfte hartcodiert `~/.claude/projects/…`.** Nach einem Kontowechsel
hätte die Prüfung ins Leere gegriffen, `resume` wäre auf `undefined` gefallen und mads hätte still
eine **frische** Session gestartet — exakt der Kontextverlust, den der Wechsel vermeiden soll.
Jetzt wird `accountConfigDir` verwendet.

**2. Die Sandbox sperrte nur `~/.claude/.credentials.json`.** Ein zweites Konto liegt in einem
anderen Ordner und wäre für Agenten-Bash lesbar geblieben — ausgerechnet das Reservekonto also
ungeschützt. `sandboxDenyReadPaths()` deckt jetzt alle Konto-Verzeichnisse ab (fail-closed, wenn
die Registry unlesbar ist).

## Falle: das Standardkonto braucht die Variable ABWESEND

`CLAUDE_CONFIG_DIR` auf `~/.claude` zu **setzen** ist nicht dasselbe wie es **wegzulassen**.
Claude Code leitet den Schlüsselbund-Eintrag unterschiedlich ab, sobald die Variable gesetzt ist —
und sucht dann einen Eintrag, den es für das Standardkonto gar nicht gibt. Verifiziert mit
`claude auth status`:

| `CLAUDE_CONFIG_DIR` | `loggedIn` |
|---|---|
| nicht gesetzt | `true` (power-blox) |
| `~/.claude` | **`false`** — „Not logged in · Please run /login" |
| `~/.claude-medici` | `true` (medici) |

`accountAgentEnv()` **löscht** die Variable deshalb für das Standardkonto, statt sie zu setzen
(Löschen statt Weglassen: so wirkt auch eine vom Sidecar geerbte Variable nicht hinein).
Der Regressionstest dazu steht in `agentEnv.test.ts`.

## Auth-Übersteuerer

`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` haben Vorrang vor dem
Schlüsselbund-Login und würden die Kontowahl wirkungslos machen. Sie werden entfernt — aber **nur**,
wenn ein anderes als das Standardverzeichnis gewählt ist. Wer mads ohne Kontowechsel nutzt und sich
bewusst per API-Key anmeldet, läuft unverändert weiter (`agentEnv.ts` → `accountAgentEnv`).

Auf diesem Rechner ist keine der drei Variablen gesetzt — die Regel ist ein Sicherheitsnetz.

## Bewusst nicht getan

* **Kein `CLAUDE_CODE_OAUTH_TOKEN`** zum Umschalten (bekannter Bug: löscht beim Beenden den
  Schlüsselbund-Eintrag und sperrt damit das andere Konto aus).
* **Kein Eintrag in der Remote-Bridge-Allowlist** (`src-tauri/src/bridge.rs`, `HOST_MESSAGE_TYPES`).
  Der Kontowechsel bestimmt, mit welchen Zugangsdaten Agenten laufen — das soll vom gekoppelten
  iPad aus nicht auslösbar sein. Fail-closed, wie bei den Permission-Modi.
* **Keine Zugangsdaten in mads.** Die Anmeldung bleibt vollständig bei Claude Code
  (macOS-Schlüsselbund, ein Eintrag je Config-Verzeichnis). mads speichert nur, welches
  Verzeichnis für welchen Stream gilt.

## Offen / noch nicht verifiziert

* **Das `rate_limit_event` ist noch nie live beobachtet worden** — ein echtes Limit lässt sich nicht
  auf Bestellung erzeugen. Die Auswertung folgt der SDK-Typdefinition (`sdk.d.ts`,
  `SDKRateLimitEvent`). Beim ersten echten Treffer sollte das Sidecar-Log gegengeprüft werden;
  dank Roh-Logging steht die tatsächliche Form dann dort.
* **Zwei mads-Instanzen gleichzeitig sind gefährlich**, seit `~/.claude-medici/projects` ein Symlink
  auf `~/.claude/projects` ist: Zwei Prozesse dürfen nie dieselbe Session-ID fortsetzen, sonst
  laufen die Transcripts ineinander. Der Projekt-Lock verhindert nur dasselbe *Projekt* zweimal.
* **Konten anlegen/bearbeiten geht bisher nur per Hand** in `~/.mads/accounts.json`. Eine
  Oberfläche dafür (Einstellungen → Anthropic-Login) wäre der nächste sinnvolle Schritt.
