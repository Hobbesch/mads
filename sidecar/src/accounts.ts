/**
 * Account-Registry: mehrere Claude-Konten, auswählbar pro Stream.
 *
 * HINTERGRUND: Ein Claude-Max-Abo hat ein 5-Stunden- und ein Wochen-Kontingent. Wer zwei Abos hat,
 * will beim Anschlagen des einen auf das andere wechseln können, ohne den laufenden Auftrag zu
 * verlieren. Claude Code trennt Konten über die Env-Variable `CLAUDE_CONFIG_DIR`: pro Verzeichnis
 * ein eigener Schlüsselbund-Eintrag, eine eigene `.claude.json`, ein eigenes `projects/`.
 *
 * mads speichert KEINE Zugangsdaten — nur, welches Config-Verzeichnis für welchen Stream gilt.
 * Die Anmeldung selbst bleibt vollständig bei Claude Code (macOS-Schlüsselbund).
 *
 * WARUM `~/.mads` statt `<repoRoot>/.mads`: Konten sind repo-ÜBERGREIFEND. Läge die Registry im
 * Projekt, hätte jedes Repo eine eigene Kontenliste und Cooldowns würden sich nicht teilen —
 * genau falsch: das Kontingent ist pro Konto global, nicht pro Projekt. Dies ist bewusst der
 * erste benutzerweite Sidecar-Store (alles andere liegt projektlokal).
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AccountCooldown, AccountProfile, AccountsState } from "../../shared/protocol.js";
import { log } from "./io.js";

/** Benutzerweites mads-Verzeichnis (NICHT projektlokal — Konten gelten repo-übergreifend). */
export function madsHomeDir(): string {
  return join(homedir(), ".mads");
}

function accountsPath(): string {
  return join(madsHomeDir(), "accounts.json");
}

/** Das Standard-Konto = Claude Codes eigener Default (`~/.claude`). Immer vorhanden. */
export const DEFAULT_ACCOUNT_ID = "default";

function defaultProfile(): AccountProfile {
  return { id: DEFAULT_ACCOUNT_ID, label: "Standard", configDir: join(homedir(), ".claude") };
}

function emptyState(): AccountsState {
  return { profiles: [defaultProfile()], activeId: DEFAULT_ACCOUNT_ID, cooldowns: {} };
}

/** `~` am Anfang auf das Home-Verzeichnis auflösen (Registry darf `~/...` enthalten). */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * E-Mail des Kontos aus `<configDir>/.claude.json` lesen — rein informativ für die Anzeige.
 * Bewusst defensiv: die Datei ist gross und gehört Claude Code; Fehler sind hier nie fatal.
 * Es wird NICHTS ausser der E-Mail gelesen und nie etwas geschrieben.
 */
function readConfigDirEmail(configDir: string): string | undefined {
  // Claude Code legt `.claude.json` unterschiedlich ab: bei gesetztem CLAUDE_CONFIG_DIR INNERHALB
  // des Verzeichnisses, im Standardfall (`~/.claude`) dagegen DANEBEN als `~/.claude.json`.
  // Beide Orte prüfen — sonst bliebe ausgerechnet das Standardkonto ohne Anzeigenamen.
  const candidates = [join(configDir, ".claude.json"), `${configDir}.json`];
  for (const path of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { oauthAccount?: { emailAddress?: string } };
      const mail = parsed.oauthAccount?.emailAddress;
      if (typeof mail === "string" && mail) return mail;
    } catch {
      /* nächster Kandidat */
    }
  }
  return undefined;
}

function sanitizeProfile(raw: unknown): AccountProfile | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id.trim() : "";
  const configDir = typeof r.configDir === "string" ? expandHome(r.configDir.trim()) : "";
  if (!id || !configDir) return undefined;
  const label = typeof r.label === "string" && r.label.trim() ? r.label.trim() : id;
  const svc = typeof r.tokenKeychainService === "string" ? r.tokenKeychainService.trim() : "";
  const mail = typeof r.declaredEmail === "string" ? r.declaredEmail.trim() : "";
  const prof: AccountProfile = { id, label, configDir };
  if (svc) prof.tokenKeychainService = svc;
  if (mail) prof.declaredEmail = mail;
  return prof;
}

/**
 * Langlebiger OAuth-Token eines Profils aus dem macOS-Schlüsselbund lesen (`claude setup-token`).
 *
 * Bewusst ein `security`-Aufruf und KEIN Klartext in `accounts.json`: die Registry darf jederzeit
 * eingesehen, kopiert und ins Backup gelegt werden — ein Token darf das nicht. Der Wert läuft über
 * stdout des Kindprozesses, nie über `argv` (dort wäre er kurzzeitig in der Prozessliste sichtbar).
 *
 * Der Rückgabewert wird NIE geloggt. Bei jedem Fehler `undefined` → der Aufrufer fällt auf die
 * Verzeichnis-Anmeldung zurück, statt den Stream gar nicht erst zu starten.
 */
export function readAccountToken(profile: AccountProfile): string | undefined {
  const service = profile.tokenKeychainService;
  if (!service) return undefined;
  try {
    const r = spawnSync("/usr/bin/security", ["find-generic-password", "-w", "-s", service], {
      encoding: "utf8",
      timeout: 10_000,
    });
    if (r.status !== 0) {
      log(`[accounts] Kein Schlüsselbund-Eintrag "${service}" für Konto "${profile.id}" — Verzeichnis-Anmeldung gilt.`);
      return undefined;
    }
    // Trimmen ist hier nicht Kosmetik: ein beim Einfügen mitkopiertes führendes Leerzeichen macht
    // den Token ungültig, und die CLI fällt dann STILL auf die Verzeichnis-Anmeldung zurück —
    // also genau auf das falsche Konto. Passiert am 05.09.2026 real.
    const token = (r.stdout ?? "").trim();
    if (!token) return undefined;
    if (!token.startsWith("sk-ant-")) {
      log(`[accounts] Eintrag "${service}" sieht nicht wie ein Claude-Token aus — ignoriert.`);
      return undefined;
    }
    return token;
  } catch (e) {
    log(`[accounts] Schlüsselbund-Zugriff für "${service}" fehlgeschlagen: ${String(e)}`);
    return undefined;
  }
}

function sanitizeCooldown(raw: unknown): AccountCooldown | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const until = typeof r.until === "number" && Number.isFinite(r.until) ? r.until : 0;
  if (until <= 0) return undefined;
  return {
    until,
    rejected: r.rejected !== false,
    window: typeof r.window === "string" ? r.window : undefined,
    utilization: typeof r.utilization === "number" ? r.utilization : undefined,
  };
}

/**
 * Registry laden. Defensiv: kaputte/fehlende Datei → Default-Zustand (ein Konto, kein Cooldown),
 * damit ein Tippfehler in der JSON niemals alle Streams lahmlegt. Abgelaufene Cooldowns werden
 * beim Laden verworfen.
 */
export function loadAccounts(now: number = Date.now()): AccountsState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(accountsPath(), "utf8"));
  } catch {
    return emptyState();
  }
  if (!parsed || typeof parsed !== "object") return emptyState();
  const p = parsed as Record<string, unknown>;

  const profiles: AccountProfile[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(p.profiles) ? p.profiles : []) {
    const prof = sanitizeProfile(raw);
    if (!prof || seen.has(prof.id)) continue;
    seen.add(prof.id);
    profiles.push(prof);
  }
  // Nur wenn GAR NICHTS konfiguriert ist, das Standard-Konto einsetzen. Nicht etwa immer: wer seine
  // Konten selbst benannt hat (und dabei `~/.claude` als eines davon führt), bekäme sonst ein
  // doppeltes Phantom-Profil auf dasselbe Verzeichnis.
  if (profiles.length === 0) profiles.push(defaultProfile());

  const cooldowns: Record<string, AccountCooldown> = {};
  const rawCooldowns = (p.cooldowns ?? {}) as Record<string, unknown>;
  const known = new Set(profiles.map((x) => x.id));
  for (const [id, raw] of Object.entries(rawCooldowns)) {
    if (!known.has(id)) continue; // Cooldown ohne Profil = Müll
    const cd = sanitizeCooldown(raw);
    if (cd && cd.until > now) cooldowns[id] = cd; // Abgelaufenes gleich aufräumen
  }

  const activeRaw = typeof p.activeId === "string" ? p.activeId : DEFAULT_ACCOUNT_ID;
  const activeId = profiles.some((x) => x.id === activeRaw) ? activeRaw : profiles[0].id;

  // E-Mail nur anreichern, nicht persistieren (sie kann sich durch Neuanmeldung ändern).
  // Bei token-gebundenen Profilen ist `<configDir>/.claude.json` KEINE Quelle mehr: unter
  // Token-Auth schreibt die CLI dort kein `oauthAccount`, der alte Eintrag bliebe stehen und
  // zeigte weiter das Konto der letzten Verzeichnis-Anmeldung — also womöglich das falsche.
  for (const prof of profiles) {
    prof.email = prof.declaredEmail ?? (prof.tokenKeychainService ? undefined : readConfigDirEmail(prof.configDir));
  }

  return { profiles, activeId, cooldowns };
}

/** Atomar schreiben (tmp + rename) — wie die projektlokalen Stores in persistence.ts. */
export function saveAccounts(state: AccountsState): void {
  try {
    mkdirSync(madsHomeDir(), { recursive: true });
    const path = accountsPath();
    const tmp = `${path}.tmp`;
    // E-Mail bewusst NICHT mitschreiben: abgeleitet, sonst veraltet sie still auf der Platte.
    const onDisk = {
      v: 1,
      activeId: state.activeId,
      profiles: state.profiles.map((p) => ({
        id: p.id,
        label: p.label,
        configDir: p.configDir,
        ...(p.tokenKeychainService ? { tokenKeychainService: p.tokenKeychainService } : {}),
        ...(p.declaredEmail ? { declaredEmail: p.declaredEmail } : {}),
      })),
      cooldowns: state.cooldowns,
    };
    writeFileSync(tmp, JSON.stringify(onDisk, null, 2));
    renameSync(tmp, path);
  } catch (e) {
    log(`[accounts] Registry konnte nicht geschrieben werden: ${String(e)}`);
  }
}

/** Profil nachschlagen; unbekannte ID → aktives Konto → erstes Profil (nie undefined). */
export function resolveProfile(state: AccountsState, accountId?: string): AccountProfile {
  return (
    state.profiles.find((p) => p.id === accountId) ??
    state.profiles.find((p) => p.id === state.activeId) ??
    state.profiles[0]
  );
}

/** Läuft für dieses Konto gerade ein Cooldown (echte Abweisung, keine blosse Vorwarnung)? */
export function inCooldown(state: AccountsState, accountId: string, now: number = Date.now()): boolean {
  const cd = state.cooldowns[accountId];
  return !!cd && cd.rejected && cd.until > now;
}

/**
 * Bestes Ausweich-Konto zu `fromId`: existiert, ist ein anderes und hat keinen aktiven Cooldown.
 * `undefined` = kein Konto frei (die UI zeigt dann den frühesten Reset-Zeitpunkt statt eines
 * Umschalt-Angebots). Bewusst KEINE automatische Umschaltung — der Wechsel bleibt eine
 * menschliche Entscheidung, weil er den laufenden Prozess neu startet.
 */
export function pickFallback(
  state: AccountsState,
  fromId: string,
  now: number = Date.now(),
): AccountProfile | undefined {
  return state.profiles.find((p) => p.id !== fromId && !inCooldown(state, p.id, now));
}

/** Frühester Zeitpunkt, zu dem irgendein Konto wieder frei wird (für „alle im Cooldown"). */
export function earliestReset(state: AccountsState, now: number = Date.now()): number | undefined {
  const times = Object.values(state.cooldowns)
    .filter((cd) => cd.rejected && cd.until > now)
    .map((cd) => cd.until);
  return times.length ? Math.min(...times) : undefined;
}

/** Cooldown setzen/aktualisieren und den neuen Zustand zurückgeben (rein, ohne I/O). */
export function withCooldown(
  state: AccountsState,
  accountId: string,
  cooldown: AccountCooldown,
): AccountsState {
  return { ...state, cooldowns: { ...state.cooldowns, [accountId]: cooldown } };
}

/** Abgelaufene Cooldowns entfernen. Gibt denselben Zustand zurück, wenn nichts zu tun war. */
export function pruneCooldowns(state: AccountsState, now: number = Date.now()): AccountsState {
  const keep = Object.entries(state.cooldowns).filter(([, cd]) => cd.until > now);
  if (keep.length === Object.keys(state.cooldowns).length) return state;
  return { ...state, cooldowns: Object.fromEntries(keep) };
}
