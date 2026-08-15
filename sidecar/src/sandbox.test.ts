import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxOptions, sandboxWritePaths, sandboxDenyReadPaths, sandboxAllowedDomains } from "./sandbox.js";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    passed++;
    console.log("PASS", name);
  } else {
    failed++;
    console.log("FAIL", name);
  }
}

const WT = "/Users/x/mads-worktrees/Repo/agent-1";
const ROOT = "/Users/x/coding/Repo";
const home = homedir();

// --- Grundschaltung ---------------------------------------------------------
const on = sandboxOptions({ cwd: WT, repoRoot: ROOT }) as { sandbox?: Record<string, unknown> };
check("Default = AN (undefined enabled)", on.sandbox?.enabled === true);
check("failIfUnavailable=true (nie still ungeschützt laufen)", on.sandbox?.failIfUnavailable === true);
check(
  "dangerouslyDisableSandbox wird ignoriert (kein Selbst-Ausbruch)",
  on.sandbox?.allowUnsandboxedCommands === false,
);
check(
  "autoAllowBashIfSandboxed standardmäßig NICHT gesetzt (mads-Gates bleiben aktiv)",
  on.sandbox?.autoAllowBashIfSandboxed === undefined,
);
check("autoAllowBash:true setzt das Flag explizit", (sandboxOptions({ cwd: WT, autoAllowBash: true }) as { sandbox?: Record<string, unknown> }).sandbox?.autoAllowBashIfSandboxed === true);
check("enabled:false → leeres Objekt (Sandbox aus)", Object.keys(sandboxOptions({ cwd: WT, enabled: false })).length === 0);

// --- Schreibpfade -----------------------------------------------------------
const w = sandboxWritePaths(WT, ROOT);
check("Worktree ist schreibbar", w.includes(WT));
check(
  "GIT-KRITISCH: <repoRoot>/.git schreibbar (sonst scheitert jeder git commit im Worktree)",
  w.includes(join(ROOT, ".git")),
);
check("Temp schreibbar", w.includes(tmpdir()) && w.includes("/private/tmp"));
check(
  "Toolchain-Caches schreibbar (Builds brechen sonst)",
  w.includes(join(home, ".npm")) && w.includes(join(home, ".cargo")) && w.includes(join(home, ".gradle")) && w.includes(join(home, ".nuget")),
);
check("kein leerer/undefined Pfad in der Liste", w.every((p) => typeof p === "string" && p.length > 0));
check("ohne repoRoot kein .git-Eintrag", !sandboxWritePaths(WT, undefined).some((p) => p.endsWith("/.git")));
check(
  "FREMDE Worktrees NICHT schreibbar (Invariante: ein Worktree pro Sub-Stream)",
  !w.includes("/Users/x/mads-worktrees/Repo/agent-2"),
);
check("Home-Wurzel selbst ist NICHT schreibbar", !w.includes(home) && !w.includes("/"));

// --- Secret-Ablagen ---------------------------------------------------------
const d = sandboxDenyReadPaths();
check(
  "SSH/AWS/GPG/Keychains gesperrt",
  d.includes(join(home, ".ssh")) && d.includes(join(home, ".aws")) && d.includes(join(home, ".gnupg")) && d.includes(join(home, "Library", "Keychains")),
);
check(
  "gh-/git-Credentials gesperrt",
  d.includes(join(home, ".config", "gh")) && d.includes(join(home, ".git-credentials")) && d.includes(join(home, ".netrc")),
);
check("Claude-Credentials gesperrt", d.includes(join(home, ".claude", ".credentials.json")));
check(
  "projekt-lokale .env bleibt LESBAR (Builds/Dev-Server brauchen sie; Klassifizierer gated weiter)",
  !d.some((p) => p.endsWith("/.env")),
);

// --- Netz -------------------------------------------------------------------
const net = (on.sandbox?.network ?? {}) as Record<string, unknown>;
const domains = sandboxAllowedDomains();
check("Paketquellen erlaubt (npm/pypi/crates/nuget/maven/go)", ["registry.npmjs.org", "pypi.org", "crates.io", "api.nuget.org", "repo.maven.apache.org", "proxy.golang.org"].every((x) => domains.includes(x)));
check("GitHub erlaubt", domains.includes("github.com") && domains.includes("api.github.com"));
check("Dev-Server dürfen lokal binden", net.allowLocalBinding === true);
check("Docker-Socket erlaubt", Array.isArray(net.allowUnixSockets) && (net.allowUnixSockets as string[]).includes("/var/run/docker.sock"));
check("NICHT alle Unix-Sockets offen", net.allowAllUnixSockets === undefined);
check(
  "Egress ist eine ALLOWLIST — beliebige Exfil-Ziele fehlen",
  !domains.includes("*") && !domains.some((x) => /pastebin|ngrok|webhook\.site|requestbin/i.test(x)),
);
check(
  "security-schwächende Schalter NICHT gesetzt",
  on.sandbox?.allowAppleEvents === undefined && on.sandbox?.enableWeakerNetworkIsolation === undefined,
);

// --- Env-Notfallschalter ----------------------------------------------------
const prev = process.env.MADS_SANDBOX;
process.env.MADS_SANDBOX = "off";
check("MADS_SANDBOX=off deaktiviert global", Object.keys(sandboxOptions({ cwd: WT })).length === 0);
process.env.MADS_SANDBOX = "1";
check("MADS_SANDBOX=1 lässt die Sandbox AN (nur off/0/false schalten ab)", (sandboxOptions({ cwd: WT }) as { sandbox?: unknown }).sandbox !== undefined);
if (prev === undefined) delete process.env.MADS_SANDBOX;
else process.env.MADS_SANDBOX = prev;

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) throw new Error(`${failed} sandbox test(s) failed`);
