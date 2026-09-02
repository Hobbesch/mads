/**
 * OS-Sandbox für Agenten-Bash (SDK-nativ, macOS: Seatbelt).
 *
 * WARUM: mads' Auto-Modus fragt bisher VORSORGLICH per Regex-Klassifizierer (shared/safe-command.ts),
 * weil ein Agenten-Befehl technisch alles darf, was der Nutzer darf. Claude Code kann deshalb so viel
 * stiller laufen, weil dort jeder Bash-Befehl OS-gesandboxed ausgeführt wird: der Schadensradius ist
 * VORAB begrenzt, statt jede Zeile vorher zu bewerten. Genau diese Schicht zieht dieses Modul ein —
 * sie ist die „echte Grenze", die safe-command.ts selbst als OS-Sandbox benennt.
 *
 * WIRKUNG (Default des SDK, wenn `enabled`): Bash darf nur im Workspace schreiben und hat KEINEN
 * Netz-Egress. `allowWrite`/`allowedDomains` öffnen gezielt, was echte Entwicklungsarbeit braucht.
 * Betroffen ist NUR Bash — Read/Edit/Write laufen weiter über mads' eigene Gates (canUseTool).
 *
 * BEDROHUNGSMODELL mads: Sub-Agents laufen autonom (Autopilot) und verarbeiten Repo-Inhalte, die
 * Prompt-Injection tragen können; der Sidecar erbt Secrets in der Umgebung. Die Sandbox nimmt einem
 * injizierten Agenten die zwei wertvollsten Ziele: Secret-Dateien lesen und Daten nach außen schicken.
 *
 * NICHT aktiviert (bewusst):
 *  • `autoAllowBashIfSandboxed` — würde Bash am mads-`canUseTool` VORBEI freigeben und damit auch
 *    mads-eigene Gates (main-Commit-Schutz, Ownership) überspringen. Erst einschalten, wenn der
 *    Klassifizierer bewusst darauf umgestellt wird (Schrittfolge: erst einsperren, dann entschlacken).
 *  • `allowAppleEvents` — hebt laut SDK die Code-Ausführungs-Isolation auf (startet fremde Apps).
 *  • `enableWeakerNetworkIsolation` — laut SDK ein Exfiltrationsvektor über trustd.
 */
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxMode } from "../../shared/protocol.js";
import { loadAccounts } from "./accounts.js";

/** Notfall-Schalter: `MADS_SANDBOX=off|0|false` deaktiviert die Sandbox global (z. B. wenn ein
 *  Toolchain-Pfad fehlt und die Arbeit sonst steht). Bewusst grob — der Normalweg ist der Parameter. */
function envDisabled(): boolean {
  return /^(0|off|false|no)$/i.test(process.env.MADS_SANDBOX ?? "");
}

/**
 * Pfade, in die Agenten-Bash schreiben darf. Über den Worktree hinaus sind das genau zwei Klassen:
 *  1) `<repoRoot>/.git` — PFLICHT für git im Worktree: `git commit` schreibt Objekte/Refs NICHT in den
 *     Worktree, sondern nach `<repoRoot>/.git/{objects,worktrees/<id>}`. Ohne diesen Pfad scheitert
 *     jeder Commit in einem Sub-Stream. Andere Worktrees liegen unter ~/mads-worktrees/… und bleiben
 *     damit weiterhin unerreichbar (Invariante „ein Worktree pro Sub-Stream").
 *  2) Temp + Toolchain-Caches — sonst brechen ganz normale Builds (npm/cargo/gradle/nuget/go schreiben
 *     ihre Caches ins Home, nicht ins Projekt).
 */
export function sandboxWritePaths(cwd?: string, repoRoot?: string): string[] {
  const home = homedir();
  const paths = [
    cwd,
    repoRoot ? join(repoRoot, ".git") : undefined,
    tmpdir(),
    "/tmp",
    "/private/tmp",
    "/var/folders",
    "/private/var/folders",
    // Toolchain-Caches (Build/Test müssen laufen, ohne zu fragen)
    join(home, ".npm"),
    join(home, ".cache"),
    join(home, "Library", "Caches"),
    join(home, ".cargo"),
    join(home, ".rustup"),
    join(home, ".gradle"),
    join(home, ".nuget"),
    join(home, ".m2"),
    join(home, ".bun"),
    join(home, ".deno"),
    join(home, ".yarn"),
    join(home, ".pnpm-store"),
    join(home, "go", "pkg"),
    join(home, ".dotnet"),
  ];
  return paths.filter((p): p is string => typeof p === "string" && p.length > 0);
}

/**
 * Secret-Ablagen, die Agenten-Bash NICHT lesen darf. Das ist die OS-harte Entsprechung zum
 * String-Gate `envOrSecretRead()` in safe-command.ts — dort konnte eine unbekannte Lese-Variante
 * (awk/base64/`< .env`/Interpreter-open) durchrutschen; hier verweigert der Kernel.
 * BEWUSST NUR globale Ablagen: projekt-lokale `.env` bleibt lesbar, weil Builds/Dev-Server sie
 * brauchen — dafür greift weiterhin der Klassifizierer.
 */
export function sandboxDenyReadPaths(): string[] {
  const home = homedir();
  return [
    join(home, ".ssh"),
    join(home, ".aws"),
    join(home, ".gnupg"),
    join(home, ".kube"),
    join(home, ".config", "gh"),
    join(home, ".config", "gcloud"),
    join(home, ".docker", "config.json"),
    join(home, ".git-credentials"),
    join(home, ".netrc"),
    join(home, ".pypirc"),
    join(home, "Library", "Keychains"),
    // Claude-eigene Zugangsdaten (der SDK-Prozess liest sie selbst — Bash hat dort nichts zu suchen).
    // Mehrkonten-Betrieb: JEDES Konto-Config-Verzeichnis sperren, nicht nur das Standard-`~/.claude`.
    // Sonst wäre ausgerechnet der zweite Account der ungeschützte — er liegt in einem anderen Ordner
    // und fiele sonst durch diese Sperre hindurch.
    ...accountCredentialPaths(),
  ];
}

/** `<configDir>/.credentials.json` für alle bekannten Konten (inkl. Standard, dedupliziert). */
function accountCredentialPaths(): string[] {
  const dirs = new Set<string>([join(homedir(), ".claude")]);
  try {
    for (const p of loadAccounts().profiles) dirs.add(p.configDir);
  } catch {
    /* Registry unlesbar → wenigstens das Standard-Verzeichnis bleibt gesperrt (fail-closed). */
  }
  return [...dirs].map((d) => join(d, ".credentials.json"));
}

/**
 * Netz-Egress-Allowlist. Ohne sie steht der Egress auf deny-by-default — das ist der Sicherheitsgewinn,
 * bricht aber jede Paket-/Toolchain-Auflösung. Enthalten sind daher genau die Quellen, die reguläre
 * Entwicklungsarbeit braucht (Registries + GitHub). Ein Exfiltrations-Ziel eines injizierten Agenten
 * steht hier NICHT drauf. Wildcards sind laut SDK-Schema erlaubt.
 */
export function sandboxAllowedDomains(): string[] {
  return [
    // JS
    "registry.npmjs.org", "*.npmjs.org", "registry.yarnpkg.com",
    // Python
    "pypi.org", "files.pythonhosted.org",
    // Rust
    "crates.io", "static.crates.io", "index.crates.io",
    // GitHub (Quellen/Releases/Actions-Artefakte)
    "github.com", "api.github.com", "codeload.github.com", "*.githubusercontent.com",
    // .NET / Java / Android
    "api.nuget.org", "*.nuget.org", "repo.maven.apache.org", "services.gradle.org",
    "plugins.gradle.org", "dl.google.com",
    // Go
    "proxy.golang.org", "sum.golang.org",
    // Anthropic (Tools/Skripte, die die API aufrufen)
    "api.anthropic.com",
  ];
}

export interface SandboxInput {
  /** Worktree des Streams (Schreib-Wurzel). */
  cwd?: string;
  /** Haupt-Repo — liefert `<repoRoot>/.git` als Schreibpfad (git-Objekte/Refs). */
  repoRoot?: string;
  /** Explizit an/aus. Ohne Angabe entscheidet die ROLLE (siehe `role`). */
  enabled?: boolean;
  /**
   * Untersuchungs-Freigabe (shared/protocol.ts → SandboxMode). Gewinnt gegen `enabled`:
   *  - "on"      → Sandbox an (wie Default).
   *  - "targets" → Sandbox an, `extraDomains` zusätzlich im Egress erlaubt (Stufe A).
   *  - "off"     → Sandbox aus (Stufe B „Freigang" — die Geländer sitzen im Orchestrator).
   */
  mode?: SandboxMode;
  /** Zusätzliche Egress-Hosts — wirken NUR im Modus "targets" (Untersuchungsziele des Projekts). */
  extraDomains?: string[];
  /** Bash ohne mads-Rückfrage freigeben, WEIL sandboxed. Default: AUS — siehe Modul-Kommentar. */
  autoAllowBash?: boolean;
  /**
   * Rolle des Streams — bestimmt den Default.
   *
   * `sub` → Sandbox AN. Sub-Agents laufen autonom im Autopilot, verarbeiten Repo-Inhalte mit
   *   möglicher Prompt-Injection, und niemand sieht jeden Schritt. Genau dort verdient die Sandbox
   *   ihren Preis — und laut Projekt-Invarianten deployt ein Sub-Agent nie.
   *
   * `integrator` → Sandbox AUS. Zwei Gründe, beide inhaltlich:
   *   (1) AUFSICHT: Der Integrator ist der Stream, mit dem der Mensch direkt spricht — das ist die
   *       Claude-Code-Situation (jemand schaut zu), nicht der unbeaufsichtigte Autopilot.
   *   (2) AUFGABE: Sync/Deploy sind seine Kernaufgabe. Die brauchen SSH-Schlüssel (denyRead ~/.ssh)
   *       UND ausgehende Verbindungen zu Prod-/Test-Servern (Egress-Allowlist). Eine Sandbox, die
   *       beides erlaubt, schützt praktisch nichts mehr — dann ist Ehrlichkeit besser als ein
   *       Feigenblatt, das nur so lange hält, bis jemand es für Schutz hält.
   * Per `enabled: true` lässt sie sich für den Integrator bewusst erzwingen (dann scheitern
   * allerdings SSH-basierte Deploys — das ist der Preis).
   */
  role?: "integrator" | "sub";
}

/**
 * Baut die `sandbox`-Option für `sdk.query()`. Leeres Objekt = Sandbox aus (SDK-Default-Verhalten).
 *
 * `failIfUnavailable: true` ist Absicht: lieber ein sichtbarer Fehler als still UNGESCHÜTZT laufende
 * Agenten. macOS bringt Seatbelt mit, der Fall sollte nicht eintreten; tritt er doch ein, will man es
 * wissen. Notfalls `MADS_SANDBOX=off`.
 */
export function sandboxOptions(input: SandboxInput = {}): Record<string, unknown> {
  // Rollen-Default: Sub-Streams an, Integrator aus (Begründung an `role`). Eine EXPLIZITE Angabe
  // (`mode`, sonst `enabled`) schlägt den Default in beide Richtungen; `MADS_SANDBOX=off` global.
  const byRole = input.role !== "integrator";
  const byMode = input.mode === undefined ? undefined : input.mode !== "off";
  const enabled = (byMode ?? input.enabled ?? byRole) && !envDisabled();
  if (!enabled) return {};
  // Untersuchungsziele (Stufe A): NUR im Modus "targets" — sonst bleiben sie wirkungslos, selbst
  // wenn ein Aufrufer sie versehentlich mitgibt.
  const extra = input.mode === "targets" ? (input.extraDomains ?? []).filter((d) => typeof d === "string" && d.trim().length > 0) : [];
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      // `dangerouslyDisableSandbox` des Bash-Tools ignorieren: ein injizierter Agent soll sich nicht
      // selbst aus der Sandbox herausschreiben können.
      allowUnsandboxedCommands: false,
      ...(input.autoAllowBash ? { autoAllowBashIfSandboxed: true } : {}),
      filesystem: {
        allowWrite: sandboxWritePaths(input.cwd, input.repoRoot),
        denyRead: sandboxDenyReadPaths(),
      },
      network: {
        allowedDomains: [...sandboxAllowedDomains(), ...extra],
        // Dev-Server/Tests binden lokale Ports (mads' Live-Preview lebt davon).
        allowLocalBinding: true,
        // Docker-CLI spricht über den Unix-Socket mit dem Daemon (macOS-only Option).
        allowUnixSockets: ["/var/run/docker.sock", join(homedir(), ".docker", "run", "docker.sock")],
      },
    },
  };
}
