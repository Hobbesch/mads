// Test für reclaimSeedFiles — rettet gitignorte Dev-Config (Secrets/Keys) aus einem Stream-Worktree,
// bevor er beim Cleanup (force-)entfernt wird. Nutzt temp-Verzeichnisse; die git-Live-Erkennung
// (detectIgnoredConfig) liefert ohne echtes Repo leer und wird toleriert → hier über die kuratierte
// `.mads/worktree-seed`-Liste getestet (der Kernpfad).
import { reclaimSeedFiles } from "./git.js";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
const w = (p: string, s: string): void => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, s);
};

const base = mkdtempSync(join(tmpdir(), "mads-reclaim-"));
try {
  const repo = join(base, "main");
  const wt = join(base, "wt-agent42");
  mkdirSync(repo, { recursive: true });
  mkdirSync(wt, { recursive: true });

  // Kuratierte Seed-Liste (aktive Pfade + ein '..'-Angriff, der ignoriert werden muss).
  w(join(repo, ".mads", "worktree-seed"), ["conf/app.json", "sub/keep.env", "sub/same.env", "conf/badlink", "../evil"].join("\n"));

  // Stream-Worktree: NEUE Datei (Haupt hat sie nicht) + geänderte + identische + ein Symlink.
  w(join(wt, "conf", "app.json"), '{"ApiKey":"neu-im-stream"}');
  w(join(wt, "sub", "keep.env"), "KEY=neu-geaendert");
  w(join(wt, "sub", "same.env"), "KEY=identisch");
  try { symlinkSync("/etc/hosts", join(wt, "conf", "badlink")); } catch { /* Symlink evtl. nicht erlaubt */ }

  // Haupt-Checkout: keep.env (alt) + same.env (identisch) existieren; app.json NICHT.
  w(join(repo, "sub", "keep.env"), "KEY=ALT-im-haupt");
  w(join(repo, "sub", "same.env"), "KEY=identisch");

  const res = reclaimSeedFiles(repo, wt);

  // (1) NEUE Datei → in den Haupt-Checkout gerettet (restored), Inhalt = Stream-Version.
  check("app.json in den Haupt gerettet", existsSync(join(repo, "conf", "app.json")));
  check("app.json Inhalt = Stream-Version", readFileSync(join(repo, "conf", "app.json"), "utf8") === '{"ApiKey":"neu-im-stream"}');
  check("restored listet conf/app.json", res.restored.includes("conf/app.json"));

  // (2) ABWEICHENDE Datei → Haupt UNBERÜHRT, Stream-Version nach .mads/reclaimed/<agentId>/ gesichert.
  check("keep.env im Haupt unverändert (nicht überschrieben)", readFileSync(join(repo, "sub", "keep.env"), "utf8") === "KEY=ALT-im-haupt");
  check("keep.env nach .mads/reclaimed/wt-agent42/ gesichert", existsSync(join(repo, ".mads", "reclaimed", "wt-agent42", "sub", "keep.env")));
  check("reclaimed-Kopie = Stream-Version", readFileSync(join(repo, ".mads", "reclaimed", "wt-agent42", "sub", "keep.env"), "utf8") === "KEY=neu-geaendert");
  check("reclaimed listet sub/keep.env", res.reclaimed.includes("sub/keep.env"));

  // (3) IDENTISCHE Datei → nichts tun.
  check("same.env nicht in restored/reclaimed", !res.restored.includes("sub/same.env") && !res.reclaimed.includes("sub/same.env"));

  // (4) Guards: '..'-Pfad und Symlink werden NIE geschrieben/gerettet.
  check("'..'-Pfad ignoriert (kein Schreiben ausserhalb repo)", !existsSync(join(base, "evil")));
  check("Symlink ignoriert (nicht kopiert)", !res.restored.includes("conf/badlink") && !res.reclaimed.includes("conf/badlink") && !existsSync(join(repo, "conf", "badlink")));

  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) throw new Error(`${failed} reclaim test(s) failed`);
} finally {
  rmSync(base, { recursive: true, force: true });
}
