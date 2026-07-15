#!/usr/bin/env node
/**
 * Setzt die Release-Version an EINER Stelle und hält alle Manifeste synchron:
 *   package.json · sidecar/package.json · src-tauri/tauri.conf.json · src-tauri/Cargo.toml
 *
 * Aufruf:  npm run version:set 0.2.0
 *          npm run version:set 0.2.0-beta.1
 *
 * SemVer-Logik (siehe src/version.ts): alles < 1.0.0 ist Pre-Release; ein Suffix wie
 * `-beta.1` definiert einen eigenen Channel. Der Git-Commit (Build-Zeit) bleibt der
 * "Patch"-Identifier und muss hier nicht angefasst werden.
 *
 * Nach dem Bump committen und neu bauen:  npm run tauri build
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const at = (rel) => fileURLToPath(new URL(rel, root));

const version = process.argv[2];
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
if (!version || !SEMVER.test(version)) {
  console.error(`Ungültige Version: ${version ?? "(keine)"}\nBeispiel: npm run version:set 0.2.0  (oder 0.2.0-beta.1)`);
  process.exit(1);
}

function bumpJson(rel) {
  const p = at(rel);
  const j = JSON.parse(readFileSync(p, "utf8"));
  const old = j.version;
  j.version = version;
  writeFileSync(p, JSON.stringify(j, null, 2) + "\n", "utf8");
  return old;
}

function bumpCargo(rel) {
  const p = at(rel);
  const txt = readFileSync(p, "utf8");
  let old = null;
  // Nur die Paket-Version (Zeilenanfang `version = "..."`), nicht inline-Deps.
  const next = txt.replace(/^version\s*=\s*"([^"]*)"/m, (_m, v) => {
    old = v;
    return `version = "${version}"`;
  });
  if (old === null) throw new Error(`Keine package-version in ${rel} gefunden`);
  writeFileSync(p, next, "utf8");
  return old;
}

const targets = [
  ["package.json", bumpJson("package.json")],
  ["sidecar/package.json", bumpJson("sidecar/package.json")],
  ["src-tauri/tauri.conf.json", bumpJson("src-tauri/tauri.conf.json")],
  ["src-tauri/Cargo.toml", bumpCargo("src-tauri/Cargo.toml")],
];

const channel = version.includes("-")
  ? version.slice(version.indexOf("-") + 1).split(".")[0]
  : Number(version.split(".")[0]) >= 1
    ? "release"
    : "pre-release";

console.log(`Version → ${version}  (Channel: ${channel})`);
for (const [file, old] of targets) console.log(`  ${old} → ${version}  ${file}`);
console.log(`\nNächste Schritte:  git add -A && git commit -m "chore(release): v${version}"  &&  npm run tauri build`);
