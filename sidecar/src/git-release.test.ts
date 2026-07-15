/**
 * Tests für deriveReleaseVersion (git.ts) — reine Diff-Analyse, kein git nötig. Via `npm run test:release`.
 * Sichert die Ableitung der Release-Version aus einem Deploy-Versions-Bump für den „Als Release committen"-Commit.
 */
import { deriveReleaseVersion } from "./git";

const results: string[] = [];
let failed = 0;
function check(name: string, cond: boolean): void {
  results.push(`${cond ? "PASS" : "FAIL"} ${name}`);
  if (!cond) failed++;
}

// Echter Bump: eine alte Version wird ersetzt → die NEUE wird bevorzugt.
check(
  "Bump im csproj → 1.0.125",
  deriveReleaseVersion(
    ["--- a/App.csproj", "+++ b/App.csproj", "-<Version>1.0.124</Version>", "+<Version>1.0.125</Version>"].join("\n"),
  ) === "1.0.125",
);
check(
  "Bump in package.json → 2.4.0",
  deriveReleaseVersion(['-  "version": "2.3.9",', '+  "version": "2.4.0",'].join("\n")) === "2.4.0",
);
// Nur Hinzufügung (kein Vorgänger) → erste +Version.
check("neue Version ohne Vorgänger → 3.1.0", deriveReleaseVersion(["+VERSION=3.1.0"].join("\n")) === "3.1.0");
// Kein semver im Diff → undefined (Fallback-Message greift beim Aufrufer).
check("kein semver → undefined", deriveReleaseVersion(["+  console.log('hi');"].join("\n")) === undefined);
// Datei-Header (+++/---) dürfen NICHT als Version zählen.
check("Datei-Header ignoriert → undefined", deriveReleaseVersion(["+++ b/v1.2.3/file", "+kein-inhalt"].join("\n")) === undefined);
// Lockfile-Dependency-Versionen ignorieren; die echte Manifest-Version gewinnt.
check(
  "Lockfile ignoriert → Manifest-Version 1.1.0",
  deriveReleaseVersion(
    [
      "--- a/package-lock.json",
      "+++ b/package-lock.json",
      '-      "version": "9.9.9",',
      '+      "version": "9.9.10",',
      "--- a/package.json",
      "+++ b/package.json",
      '-  "version": "1.0.0",',
      '+  "version": "1.1.0",',
    ].join("\n"),
  ) === "1.1.0",
);
// Deklarationszeile (version-Key) wird einer beliebigen Zahl im Diff vorgezogen.
check(
  "version-Key vor beliebiger Zahl",
  deriveReleaseVersion(["+timeout = 5.0.0", '-  "version": "2.0.0",', '+  "version": "2.1.0",'].join("\n")) === "2.1.0",
);

for (const r of results) console.log(r);
console.log(`\n${results.length - failed} passed, ${failed} failed`);
if (failed > 0) throw new Error(`${failed} git-release test(s) failed`);
