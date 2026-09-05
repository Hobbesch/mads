/**
 * „Konto neu verbinden" — geführter `claude setup-token`-Flow mit Identitätsprüfung.
 *
 * WARUM ÜBERHAUPT: Die Verzeichnis-Anmeldung (`claude auth login` unter `CLAUDE_CONFIG_DIR`)
 * trennt die Konten zwar wirklich, aber WELCHES Konto in einem Verzeichnis landet, entscheidet die
 * BROWSER-Sitzung — `--email` wird ignoriert. Am 05.09.2026 liefen dadurch beide mads-Profile
 * wochenlang still auf demselben Konto: die Kontingent-Anzeige zeigte zweimal dieselben Zahlen,
 * und nichts daran sah nach einem Fehler aus. Genau diese stille Verwechslung schliesst dieser
 * Flow — nicht durch Bequemlichkeit, sondern durch die Prüfung in Schritt 4.
 *
 * ABLAUF
 *   1. `claude setup-token` starten (gepipte stdio, kein Terminal nötig)
 *   2. Authorize-URL aus der Ausgabe fischen → Frontend zeigt sie als Knopf
 *   3. Der Mensch meldet sich im Browser an und fügt den Code ins Modal → geht nach stdin
 *   4. Token messen (Kontingent-Header) und mit den ANDEREN Profilen vergleichen. Gleiches
 *      Konto → „duplicate", Speichern nur nach ausdrücklicher Bestätigung
 *   5. Token in den macOS-Schlüsselbund, in `accounts.json` nur der VERWEIS darauf
 *
 * DER TOKEN VERLÄSST DIESES MODUL NICHT: nie ins Log, nie in `argv` (dort stünde er kurz in der
 * Prozessliste), nie in eine Datei, nie ins Protokoll zum Frontend. Er lebt im Speicher, bis er im
 * Schlüsselbund liegt.
 *
 * Der Browser-Schritt bleibt bewusst manuell — er IST die Zustimmung zu einer Anmeldung.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import type { AccountProfile, AccountRelinkPhase } from "../../shared/protocol.js";
import { loadAccounts, readAccountToken, saveAccounts } from "./accounts.js";
import { log } from "./io.js";

/** Kontingent-Fenster eines Kontos — als Fingerabdruck benutzt, nicht als Anzeige. */
export interface AccountFingerprint {
  /** Epoche (s) des 5-Stunden-Fensters. Rotiert alle 5 h. */
  fiveHourReset?: number;
  /**
   * Epoche (s) des Wochenfensters. DER eigentliche Diskriminator: der Anker liegt pro Konto
   * anders und bleibt eine Woche stehen (gemessen 05.09.2026: 09.09. vs. 11.09. für die beiden
   * Konten auf diesem Rechner). Das 5-Stunden-Fenster allein trüge nicht — zwei ungenutzte Konten
   * können dieselbe Fenstergrenze haben.
   */
  sevenDayReset?: number;
}

/**
 * Sind zwei Fingerabdrücke dasselbe Konto? Bewusst konservativ: nur ein Treffer in BEIDEN
 * Fenstern gilt. Fehlt der Wochenwert, wird NICHT geraten — dann lieber keine Warnung als eine
 * falsche, die den Menschen von einer richtigen Konfiguration abhält.
 */
export function sameAccount(a: AccountFingerprint, b: AccountFingerprint): boolean {
  if (a.sevenDayReset == null || b.sevenDayReset == null) return false;
  if (a.fiveHourReset == null || b.fiveHourReset == null) return false;
  return a.sevenDayReset === b.sevenDayReset && a.fiveHourReset === b.fiveHourReset;
}

/** Authorize-URL aus einer Ausgabezeile fischen. Bewusst breit: der Text darf sich ändern. */
export function extractAuthUrl(chunk: string): string | undefined {
  const m = chunk.match(/https:\/\/[^\s"'<>]*oauth[^\s"'<>]*/i) ?? chunk.match(/https:\/\/claude\.ai\/[^\s"'<>]+/i);
  return m?.[0];
}

/** Token aus der Ausgabe fischen. Claude-Tokens beginnen mit `sk-ant-`. */
export function extractToken(chunk: string): string | undefined {
  return chunk.match(/sk-ant-[A-Za-z0-9_-]{20,}/)?.[0];
}

/**
 * Pfad der `claude`-CLI. Reihenfolge: ausdrückliche Übersteuerung (auch für Tests) → die vom
 * Agent-SDK mitgelieferte Binärdatei (dieselbe, die mads für Streams benutzt) → PATH.
 */
export function resolveClaudeBin(): string {
  const override = process.env.MADS_CLAUDE_BIN;
  if (override) return override;
  try {
    const req = createRequire(import.meta.url);
    const sdkMain = req.resolve("@anthropic-ai/claude-agent-sdk");
    // …/node_modules/@anthropic-ai/claude-agent-sdk/… → …/node_modules/@anthropic-ai/
    let dir = dirname(sdkMain);
    for (let i = 0; i < 6 && dir !== dirname(dir); i++) {
      const cand = join(dirname(dir), `claude-agent-sdk-${process.platform}-${process.arch}`, "claude");
      if (existsSync(cand)) return cand;
      dir = dirname(dir);
    }
  } catch {
    /* SDK nicht auflösbar → PATH */
  }
  return "claude";
}

/**
 * Kontingent-Header eines Tokens messen. Kostet einen minimalen Turn (`max_tokens: 1`); ein
 * abgewiesener Aufruf (429) liefert die Header GENAUSO — für den Fingerabdruck reicht das, ein
 * erschöpftes Konto lässt sich also ebenso identifizieren wie ein freies.
 */
export async function fingerprintToken(token: string, timeoutMs = 20_000): Promise<AccountFingerprint | undefined> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com"}/v1/messages`, {
      method: "POST",
      signal: ctl.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1,
        system: "You are Claude Code, Anthropic's official CLI for Claude.",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    const num = (h: string): number | undefined => {
      const v = r.headers.get(h);
      const n = v == null ? NaN : Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    const fp = {
      fiveHourReset: num("anthropic-ratelimit-unified-5h-reset"),
      sevenDayReset: num("anthropic-ratelimit-unified-7d-reset"),
    };
    // Weder 401 noch 429 sind hier ein Fehler: erst FEHLENDE Header machen den Token unbrauchbar.
    if (fp.fiveHourReset == null && fp.sevenDayReset == null) {
      log(`[relink] Kontingent-Header fehlen (HTTP ${r.status}) — Token vermutlich ungültig.`);
      return undefined;
    }
    return fp;
  } catch (e) {
    log(`[relink] Messung fehlgeschlagen: ${String(e)}`);
    return undefined;
  } finally {
    clearTimeout(t);
  }
}

/** Token in den Schlüsselbund legen. Wert über stdin — NIE über `argv`. */
export function storeToken(service: string, token: string): boolean {
  const r = spawnSync(
    "/usr/bin/security",
    ["add-generic-password", "-U", "-a", userInfo().username, "-s", service, "-w"],
    { input: `${token}\n${token}\n`, encoding: "utf8", timeout: 15_000 },
  );
  if (r.status !== 0) {
    log(`[relink] Schlüsselbund-Schreibzugriff auf "${service}" fehlgeschlagen (status ${r.status}).`);
    return false;
  }
  return true;
}

export interface RelinkUpdate {
  accountId: string;
  phase: AccountRelinkPhase;
  url?: string;
  message?: string;
  duplicateOf?: string;
}

/**
 * Ein Flow zur Zeit. Mehr wäre nicht nur unnötig, sondern gefährlich: zwei parallele
 * `setup-token`-Läufe teilen sich dieselbe Browser-Sitzung und liefern damit garantiert
 * dasselbe Konto — also genau den Fehler, den dieser Flow verhindern soll.
 */
export class AccountRelink {
  private child?: ChildProcess;
  private accountId?: string;
  private buf = "";
  private urlSent = false;
  /** Nach der Messung: Token, der auf die Bestätigung des Menschen wartet. Nur im Speicher. */
  private pending?: { token: string; service: string };
  private timer?: NodeJS.Timeout;

  constructor(private readonly emit: (u: RelinkUpdate) => void) {}

  get activeFor(): string | undefined {
    return this.accountId;
  }

  start(accountId: string): void {
    if (this.child) this.cancel("Vorheriger Versuch abgebrochen.");
    const prof = loadAccounts().profiles.find((p) => p.id === accountId);
    if (!prof) {
      this.emit({ accountId, phase: "error", message: `Unbekanntes Konto „${accountId}".` });
      return;
    }
    this.accountId = accountId;
    this.buf = "";
    this.urlSent = false;
    this.pending = undefined;
    this.emit({ accountId, phase: "starting" });

    const bin = resolveClaudeBin();
    try {
      // Ohne CLAUDE_CONFIG_DIR und ohne geerbte Auth-Übersteuerer: `setup-token` soll eine FRISCHE
      // Anmeldung führen und nicht die bestehende bestätigen.
      const env = { ...process.env };
      delete env.CLAUDE_CONFIG_DIR;
      delete env.CLAUDE_CODE_OAUTH_TOKEN;
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;
      this.child = spawn(bin, ["setup-token"], { env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      this.fail(`„claude setup-token" liess sich nicht starten: ${String(e)}`);
      return;
    }

    const onData = (d: Buffer): void => this.onOutput(d.toString());
    this.child.stdout?.on("data", onData);
    this.child.stderr?.on("data", onData);
    this.child.on("error", (e) => this.fail(`„claude setup-token" fehlgeschlagen: ${String(e)}`));
    this.child.on("close", (code) => void this.onClose(code));

    // Kommt binnen 60 s keine URL, hängt der Flow (z. B. weil die CLI doch ein Terminal erwartet).
    // Dann lieber ehrlich abbrechen und den Weg von Hand nennen, als den Menschen warten lassen.
    this.timer = setTimeout(() => {
      if (!this.urlSent) this.fail("Keine Anmelde-Adresse erhalten. Im Terminal: `claude setup-token`.");
    }, 60_000);
  }

  submitCode(code: string): void {
    if (!this.child || !this.accountId) return;
    const trimmed = code.trim();
    if (!trimmed) return;
    this.emit({ accountId: this.accountId, phase: "verifying" });
    this.child.stdin?.write(`${trimmed}\n`);
  }

  /** Speichern, obwohl die Messung dasselbe Konto wie ein anderes Profil ergeben hat. */
  confirmDuplicate(): void {
    if (!this.pending || !this.accountId) return;
    const { token, service } = this.pending;
    this.pending = undefined;
    this.finish(this.accountId, service, token);
  }

  cancel(message = "Abgebrochen."): void {
    const id = this.accountId;
    this.cleanup();
    if (id) this.emit({ accountId: id, phase: "error", message });
  }

  private onOutput(text: string): void {
    this.buf += text;
    if (!this.urlSent && this.accountId) {
      const url = extractAuthUrl(this.buf);
      if (url) {
        this.urlSent = true;
        this.emit({ accountId: this.accountId, phase: "awaiting_code", url });
      }
    }
  }

  private async onClose(code: number | null): Promise<void> {
    const accountId = this.accountId;
    if (!accountId) return;
    const token = extractToken(this.buf);
    // Ausgabe ab hier vergessen — sie enthält den Token.
    this.buf = "";
    if (this.timer) clearTimeout(this.timer);
    this.child = undefined;
    if (!token) {
      this.fail(code === 0 ? "Kein Token in der Ausgabe gefunden." : `„claude setup-token" endete mit Code ${code}.`);
      return;
    }

    this.emit({ accountId, phase: "verifying" });
    const state = loadAccounts();
    const prof = state.profiles.find((p) => p.id === accountId);
    const service = prof?.tokenKeychainService || `mads-account-${accountId}`;

    const fp = await fingerprintToken(token);
    if (!fp) {
      this.fail("Der neue Token liess sich nicht prüfen — nicht gespeichert.");
      return;
    }

    // Die Prüfung, um die es geht: dasselbe Konto wie ein ANDERES Profil?
    for (const other of state.profiles) {
      if (other.id === accountId) continue;
      const otherToken = readAccountToken(other);
      if (!otherToken) continue;
      const otherFp = await fingerprintToken(otherToken);
      if (otherFp && sameAccount(fp, otherFp)) {
        this.pending = { token, service };
        this.emit({
          accountId,
          phase: "duplicate",
          duplicateOf: other.label,
          message:
            `Dieser Zugang gehört zum selben Konto wie „${other.label}". ` +
            `Wahrscheinlich war der Browser noch mit dem anderen Konto angemeldet — ` +
            `dort abmelden oder ein privates Fenster benutzen und erneut verbinden.`,
        });
        return;
      }
    }

    this.finish(accountId, service, token);
  }

  private finish(accountId: string, service: string, token: string): void {
    if (!storeToken(service, token)) {
      this.fail("Der Token liess sich nicht im Schlüsselbund ablegen.");
      return;
    }
    const state = loadAccounts();
    const profiles = state.profiles.map((p) => (p.id === accountId ? { ...p, tokenKeychainService: service } : p));
    saveAccounts({ ...state, profiles });
    log(`[relink] Konto "${accountId}" neu verbunden (Schlüsselbund-Eintrag "${service}").`);
    this.cleanup();
    this.emit({ accountId, phase: "done" });
  }

  private fail(message: string): void {
    const id = this.accountId;
    this.cleanup();
    if (id) this.emit({ accountId: id, phase: "error", message });
  }

  private cleanup(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    try {
      this.child?.kill();
    } catch {
      /* schon beendet */
    }
    this.child = undefined;
    this.accountId = undefined;
    this.buf = "";
    this.urlSent = false;
    this.pending = undefined;
  }
}
