# Koordination: Parallel-Streams `postfach-integration` + `pst-test`

> **Transientes Koordinations-Artefakt** ([`multi-agent.md`](../../multi-agent.md) §8). Es koordiniert zwei
> gleichzeitig laufende Sub-Streams, damit sie sich im Mail-Stack **nicht in die Quere kommen**.
> **Lifecycle:** löschen, sobald beide Branches gemerged sind.
>
> - **Integrator:** der Master-Stream in `main` (merged seriell, löst Konflikte).
> - **Sub-Stream A:** `feat/postfach-integration` — Account-/Postfach-Switcher in die Bar
>   (neben Kategorien + Archiv), damit man direkt zwischen Postfächern wechselt.
> - **Sub-Stream B:** `feat/pst-test` — die neue PST-Integration umfangreich testen +
>   Bugs/Kinderkrankheiten ausmerzen, bevor der Bereich abgeschlossen wird.
>
> Beide branchten von `main` @ `e04367b`. **Zeilennummern unten sind der Stand am
> Branch-Punkt** und driften, sobald editiert wird — der stabile Anker ist der
> **Funktions-/Datei-Name**, nicht die Zeile.

## Das Bild in einem Satz

**pst-test = PST-Backend + Dispatch + Tests** (stabilisieren). **postfach-integration =
Account-Shell-UI** (neuer Switcher in der Bar). Sie berühren `mail.py` und `mail.html`, aber
in **verschiedenen Funktionen/Regionen** — die Überlappung ist klein und per Single-Owner
abgrenzbar.

## Exklusiv — kein Konflikt möglich

| `pst-test` besitzt allein | `postfach-integration` besitzt allein |
| --- | --- |
| `src/paix/mail/pst/**` (alle Module) | Folder-Tree-**Render**-Route `folder_tree_partial()` (`mail.py` ~2450–2580) |
| Alle `_pst_*`-Helfer in `mail.py` (`_pst_folder_messages_partial`, `_pst_message_detail_partial`, `_move_single_message_pst`, `_bulk_move_messages_pst`, `_pst_move_targets`, `_tier2_classify_pst`, `_run_tier2_pass_pst`, `_pst_scan_results`, `_purge_folder_pst`, … ~20 Funktionen) | Der **Account-Switcher** selbst — **als neue Partial** `partials/_mail_account_switcher.html` bauen → null Konflikt |
| Fast alle `is_pst`-Branches (move/mark/classify/attachment/purge/tier2) | Neue Switcher-CSS-Klassen in `app.css` (**neue Selektoren ans Dateiende**) |
| `_fetch_pst_folder_list_sync()` + die `is_pst`-Branch in `refresh_folders()` (`mail_state.py` ~271, ~308) | Kategorien-/Archiv-Verdrahtung der Bar (Routes ~8119–8180 Kategorien, ~9243–9401 Archiv) |
| PST-Setup-/Manage-Templates (`mail_setup_pst.html`, `mail_pst_manage.html`, `_mail_pst_mount_status.html`, `mail_setup_type_picker.html`) | — |
| Alle `tests/test_mail_pst_*.py` | — |

## Die geteilten Nähte → Single-Owner-Regel

Jede geteilte Region gehört **genau einem** Stream. Der andere fasst sie **nicht** an.

| Naht | Owner | Regel für den anderen |
| --- | --- | --- |
| `mail_account_view()` (`mail.py` ~2406–2442) + Account-Listen-Stelle (~2379 `if a.is_pst`) | **postfach** | Das ist *die* Account-Render-Route. Der `"is_pst"`-Flag-Durchgang (~2438) bleibt; pst-test ändert ihn nicht. |
| Account-Header in `mail.html` (~254–310) + dessen CSS (`.mail-folder-tree-account-badge`, `app.css` ~1539–1550) | **postfach** | Der Switcher *ersetzt* den Header und zeigt das „PST"-Badge ohnehin pro Account → pst-test braucht ihn nicht. |
| `MailAccountState`-Felder (`mail_state.py` ~86–160) | trennbar | postfach legt „active account" auf **`AppState`**-Ebene ab (nicht in `MailAccountState`); pst-test ergänzt nur PST-Felder. Verschiedene Stellen → trivial. |

**Unvermeidbarer geteilter Edit** (z. B. pst-test findet einen echten Bug im PST-Badge):
**nicht parallel editieren** → als *winziger eigenständiger* PR **zuerst auf `main`** landen,
dann rebasen beide ([`multi-agent.md`](../../multi-agent.md) §6, Option A — land-first).

## Integrations-Reihenfolge (Integrator-Job)

- **pst-test landet kontinuierlich** (kleine Bugfix-PRs, sobald ein Fehler gefunden ist) —
  berührt `pst/**` + `_pst_`-Helfer, die postfach nicht anfasst → **konfliktfrei, jederzeit mergebar**.
- **postfach landet als ein Feature-PR**, wenn fertig.
- **Rebase-Kadenz:** beide täglich `git rebase origin/main`. postfach rebaset **zusätzlich,
  sobald ein pst-test-PR merged** — hält die `mail.py`-Basis frisch, sodass der Feature-Merge
  trivial bleibt.
- Der Integrator merged **seriell**, **rebase-before-merge**, nie rote-CI / stale-base
  ([`multi-agent.md`](../../multi-agent.md) §7).

## Tipp zur Konflikt-Minimierung

`postfach-integration`: den Switcher als **neue Partial** (`_mail_account_switcher.html`)
bauen und in `mail.html` per Ein-Zeilen-`{% include %}` einhängen — dann schrumpft die
`mail.html`-Naht auf eine einzige Zeile, und der Großteil der neuen UI liegt in einer
**neuen, konfliktfreien** Datei (Prinzip „neue Dateien bevorzugen", `multi-agent.md` §6).
