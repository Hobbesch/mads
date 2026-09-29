/**
 * Modell-Prüfung beim Start: welche Modelle stehen HIER UND JETZT fürs Programmieren bereit?
 *
 * Zwei Quellen, beide nötig (Begründung in `shared/models.ts`):
 *
 *  1. **Anthropic Models-API** (`GET /v1/models`) — was Anthropic für dieses Konto anbietet, mit
 *     Kontextfenster und Effort-Fähigkeiten. Braucht einen Zugang, den mads OHNEHIN schon hat
 *     (Env-Variable oder der Schlüsselbund-Token eines Konto-Profils). mads liest dafür KEINE
 *     fremden Zugangsdaten aus — gibt es keinen, entfällt Quelle 1 ersatzlos (siehe `credential()`).
 *  2. **Der Katalog der gebündelten Claude-Code-CLI** — ohne Netz und ohne Zugang lesbar. Er ist
 *     die härtere Schranke: die API weist ein Modell ab, das die CLI-Version noch nicht kennt
 *     („Claude Code 2.1.278 does not support this model; version 2.1.280 or newer is required").
 *     Genau daran fehlten Opus 5.5 und Sonnet 5.5 — nicht am Katalog im Frontend allein.
 *
 * Ergebnis wird in `~/.mads/models.json` zwischengespeichert: ohne Netz startet mads mit dem
 * letzten bekannten Befund statt mit der ältesten Liste. Der CLI-Scan wird über einen
 * Fingerabdruck (Pfad/Größe/mtime/Version) gecacht — die Binärdatei ist ~200 MB groß und ändert
 * sich nur bei einem SDK-Update.
 */

import { createReadStream, existsSync, mkdirSync, renameSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { madsHomeDir, readAccountToken, resolveProfile } from "./accounts.js";
import { resolveClaudeBin } from "./accountRelink.js";
import { log } from "./io.js";
import { buildCatalog, builtinCatalog, type ApiModel, type ModelCatalog } from "../../shared/models.js";
import type { AccountProfile, AccountsState } from "../../shared/protocol.js";

/** Zwischenspeicher-Format. Bewusst die ROHBEFUNDE, nicht der fertige Katalog: ändert mads seine
 *  kuratierten Texte oder die Filterregel, wirkt das auch auf einen alten Zwischenspeicher. */
interface ModelCache {
  checkedAt: number;
  cliVersion?: string;
  /** Pfad/Größe/mtime der CLI — ändert er sich, wird neu gescannt. */
  cliFingerprint?: string;
  cliIds?: string[];
  apiModels?: ApiModel[];
  /** Zeitpunkt der letzten ERFOLGREICHEN API-Abfrage (kann älter sein als `checkedAt`). */
  apiCheckedAt?: number;
}

function cachePath(): string {
  return join(madsHomeDir(), "models.json");
}

function loadCache(): ModelCache | undefined {
  try {
    const raw = JSON.parse(readFileSync(cachePath(), "utf8")) as ModelCache;
    return raw && typeof raw === "object" && typeof raw.checkedAt === "number" ? raw : undefined;
  } catch {
    return undefined; // kein Zwischenspeicher (erster Start) oder beschädigt — beides unkritisch
  }
}

function saveCache(c: ModelCache): void {
  try {
    mkdirSync(madsHomeDir(), { recursive: true });
    const tmp = `${cachePath()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(c, null, 2)}\n`, "utf8");
    renameSync(tmp, cachePath()); // atomar — ein Absturz mitten im Schreiben lässt keine halbe Datei zurück
  } catch (e) {
    log(`[models] Zwischenspeicher nicht schreibbar: ${String(e)}`);
  }
}

/** Fingerabdruck der CLI-Binärdatei (ohne sie zu lesen). */
function cliFingerprint(bin: string): string | undefined {
  try {
    const st = statSync(bin);
    return `${bin}:${st.size}:${Math.round(st.mtimeMs)}`;
  } catch {
    return undefined; // `claude` liegt nur im PATH → kein verlässlicher Fingerabdruck
  }
}

export function cliVersion(bin: string, timeoutMs = 10_000): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(bin, ["--version"], { timeout: timeoutMs }, (err, stdout) => {
      if (err) return resolve(undefined);
      const m = /(\d+\.\d+\.\d+)/.exec(String(stdout));
      resolve(m?.[1]);
    });
  });
}

/**
 * Model-IDs aus der gebündelten CLI lesen.
 *
 * BEWUSST ein Scan über die Binärdatei und keine API: Claude Code bietet keinen Befehl, der seinen
 * Modell-Katalog maschinenlesbar ausgibt. Der Scan ist fehlertolerant konstruiert — findet er
 * nichts, gilt „CLI-Katalog unbekannt" (`[]`), und mads verliert nur die Update-Markierung, nie
 * die Auswahl. Gelesen wird in Blöcken mit Überlappung, damit keine ID an einer Blockgrenze
 * zerfällt.
 */
export function scanCliModelIds(bin: string, timeoutMs = 30_000): Promise<string[]> {
  return new Promise((resolve) => {
    const found = new Set<string>();
    if (!existsSync(bin)) return resolve([]);
    // Minor einstellig mit Lookahead: im gepackten JS der CLI stossen Strings aneinander, so dass
    // „claude-haiku-3-5" + „5…" als „claude-haiku-3-55" erscheint. Ein mehrstelliger Minor wäre
    // also fast immer ein Artefakt — lieber die kurze Form greifen und den Rest verwerfen.
    const re = /claude-(?:fable|mythos|opus|sonnet|haiku)-\d{1,2}(?:-\d(?!\d))?/g;
    const OVERLAP = 64; // länger als jede Model-ID
    let tail = "";
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stream.destroy();
      resolve([...found]);
    };
    const timer = setTimeout(() => {
      log("[models] CLI-Scan abgebrochen (Zeitlimit) — Katalog der CLI bleibt unbekannt.");
      found.clear();
      finish();
    }, timeoutMs);
    // latin1: byteweise, verlustfrei für ASCII-Treffer und ohne UTF-8-Ersatzzeichen an Blockgrenzen.
    const stream = createReadStream(bin, { encoding: "latin1", highWaterMark: 4 * 1024 * 1024 });
    stream.on("data", (chunk) => {
      const text = tail + String(chunk);
      for (const m of text.matchAll(re)) found.add(m[0]);
      tail = text.slice(-OVERLAP);
    });
    stream.on("error", (e) => {
      log(`[models] CLI-Scan fehlgeschlagen: ${String(e)}`);
      found.clear();
      finish();
    });
    stream.on("end", finish);
  });
}

/** Ein nutzbarer Zugang zur Anthropic-API — samt der Header-Form, die er verlangt. */
type Credential = { headers: Record<string, string>; origin: string };

/**
 * Zugang für die Models-Abfrage bestimmen.
 *
 * REIHENFOLGE = Vertrauenswürdigkeit, und die Grenze ist bewusst eng: mads nimmt NUR, was ihm
 * ohnehin gehört — die geerbten Env-Variablen und den Token, den der Nutzer selbst über
 * `claude setup-token` an ein mads-Konto gebunden hat. Der Schlüsselbund-Eintrag von Claude Code
 * (Verzeichnis-Anmeldung) wird NICHT angetastet: mads speichert und liest keine fremden
 * Zugangsdaten (siehe `accounts.ts`). Fehlt beides, bleibt der CLI-Katalog die einzige Quelle.
 */
function credential(active?: AccountProfile): Credential | undefined {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (apiKey) return { headers: { "x-api-key": apiKey }, origin: "ANTHROPIC_API_KEY" };
  const bearer = (process.env.ANTHROPIC_AUTH_TOKEN || process.env.CLAUDE_CODE_OAUTH_TOKEN)?.trim();
  if (bearer) return { headers: oauthHeaders(bearer), origin: "Token aus der Umgebung" };
  const token = active ? readAccountToken(active) : undefined;
  if (token) return { headers: oauthHeaders(token), origin: `Konto-Token „${active?.label ?? active?.id}"` };
  return undefined;
}

function oauthHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" };
}

/**
 * `GET /v1/models` abfragen. Ein Fehlschlag ist NIE fatal: er kostet nur die Live-Markierung.
 * Der Token selbst wird nie geloggt (nur seine Herkunft).
 */
export async function fetchApiModels(cred: Credential, timeoutMs = 15_000): Promise<ApiModel[] | undefined> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const base = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
    const r = await fetch(`${base}/v1/models?limit=100`, {
      signal: ctl.signal,
      headers: { ...cred.headers, "anthropic-version": "2023-06-01" },
    });
    if (!r.ok) {
      log(`[models] Models-API antwortete HTTP ${r.status} (${cred.origin}) — eingebaute Liste gilt weiter.`);
      return undefined;
    }
    const body = (await r.json()) as { data?: unknown };
    if (!Array.isArray(body.data)) return undefined;
    return body.data
      .filter((m): m is Record<string, unknown> => !!m && typeof m === "object" && typeof (m as { id?: unknown }).id === "string")
      .map((m) => ({
        id: String(m.id),
        display_name: typeof m.display_name === "string" ? m.display_name : undefined,
        max_input_tokens: typeof m.max_input_tokens === "number" ? m.max_input_tokens : undefined,
        capabilities: m.capabilities,
      }));
  } catch (e) {
    log(`[models] Models-API nicht erreichbar: ${String(e)}`);
    return undefined;
  } finally {
    clearTimeout(t);
  }
}

/** Menschenlesbare Begründung für das Einstellungs-Panel. */
function noteFor(apiOk: boolean, cliCount: number, credOrigin: string | undefined, cliVer: string | undefined): string {
  const parts: string[] = [];
  parts.push(apiOk ? `bei Anthropic geprüft (${credOrigin})` : credOrigin ? "Anthropic nicht erreichbar" : "kein API-Zugang für die Modell-Liste");
  parts.push(cliCount > 0 ? `Claude Code ${cliVer ?? "?"} kennt ${cliCount} Modelle` : "Katalog der CLI unbekannt");
  return parts.join(" · ");
}

export interface DiscoverOptions {
  /** IDs, die im Katalog bleiben MÜSSEN (gerade gewählte Modelle). */
  keep?: string[];
  /** true = Zwischenspeicher ignorieren und alles neu erheben (Knopf „Jetzt prüfen"). */
  force?: boolean;
  /** Konten-Registry für den Konto-Token (optional — ohne sie nur Env-Zugänge). */
  accounts?: AccountsState;
}

/**
 * Den aktuellen Katalog erheben. Läuft beim Sidecar-Start einmal und danach nur auf Anforderung.
 * Wirft nie — im schlimmsten Fall kommt der eingebaute Katalog zurück.
 */
export async function discoverModels(opts: DiscoverOptions = {}): Promise<ModelCatalog> {
  const keep = opts.keep ?? [];
  const cache = opts.force ? undefined : loadCache();
  // NUR die Binärdatei befragen, die der Agent-SDK auch wirklich startet. `resolveClaudeBin()`
  // fällt zur Not auf den blossen Namen „claude" im PATH zurück — das ist die global installierte
  // Claude-Code-Version des Nutzers und oft eine ANDERE (hier: 2.1.231 global vs. 2.1.284
  // gebündelt). Die daraus gelesene Liste würde neue Modelle fälschlich als „nicht unterstützt"
  // sperren. Kein auflösbarer Pfad ⇒ „Katalog unbekannt", und mads markiert gar nichts.
  const bin = resolveClaudeBin();
  const binPath = existsSync(bin) ? bin : undefined;
  const fp = binPath ? cliFingerprint(binPath) : undefined;

  let cliIds: string[] = [];
  let ver: string | undefined;
  if (!binPath) {
    log(`[models] Gebündelte Claude-Code-Binärdatei nicht auflösbar („${bin}") — ihr Modell-Katalog bleibt unbekannt.`);
  } else if (fp && cache?.cliFingerprint === fp && cache.cliIds?.length) {
    cliIds = cache.cliIds; // unveränderte Binärdatei → der Scan von letztem Mal gilt weiter
    ver = cache.cliVersion;
  } else {
    ver = await cliVersion(binPath);
    cliIds = await scanCliModelIds(binPath);
    if (cliIds.length) log(`[models] Claude Code ${ver ?? "?"} kennt ${cliIds.length} Modelle (lokaler Katalog).`);
  }

  const active = opts.accounts ? resolveProfile(opts.accounts) : undefined;
  const cred = credential(active);
  const fresh = cred ? await fetchApiModels(cred) : undefined;
  const apiModels = fresh ?? cache?.apiModels ?? [];

  const now = Date.now();
  saveCache({
    checkedAt: now,
    cliVersion: ver,
    cliFingerprint: fp,
    cliIds,
    apiModels,
    apiCheckedAt: fresh ? now : cache?.apiCheckedAt,
  });

  const models = buildCatalog(apiModels, cliIds, keep);
  if (!models.length) return builtinCatalog();
  // „live" heisst: Anthropic hat GERADE geantwortet. Ein gültiger CLI-Katalog ohne API-Antwort
  // ist ein LOKALER Befund — weniger als live, aber deutlich mehr als ein alter Zwischenspeicher
  // (ein unveränderter Fingerabdruck heisst: der Scan von letztem Mal beschreibt genau die CLI,
  // die gerade läuft). Diese Unterscheidung steht so auch im Einstellungs-Panel.
  const local = cliIds.length > 0;
  return {
    models,
    status: fresh ? "live" : local ? "local" : apiModels.length ? "cache" : "builtin",
    checkedAt: fresh || local ? now : cache?.checkedAt,
    note: noteFor(!!fresh, cliIds.length, cred?.origin, ver),
    cliVersion: ver,
  };
}
