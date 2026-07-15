// Test für die projektweite „Immer erlauben"-Persistenz (.mads/permissions.json). Sichert zu, dass
// nur MERKBARE Kategorien gespeichert/geladen werden — insbesondere `danger` NIE persistiert.
import { loadApprovedKinds, saveApprovedKinds } from "./permissions.js";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("PASS", name); } else { failed++; console.log("FAIL", name); }
}

const base = mkdtempSync(join(tmpdir(), "mads-perms-"));
try {
  // (1) Speichern + Laden eines Roundtrips; danger wird beim Speichern gefiltert.
  saveApprovedKinds(base, new Set(["network", "pkg", "danger"] as never));
  const written = JSON.parse(readFileSync(join(base, ".mads", "permissions.json"), "utf8"));
  check("danger NICHT persistiert", !written.approvedCommandKinds.includes("danger"));
  check("network + pkg persistiert", written.approvedCommandKinds.includes("network") && written.approvedCommandKinds.includes("pkg"));
  const loaded = loadApprovedKinds(base);
  check("Roundtrip lädt network+pkg", loaded.has("network") && loaded.has("pkg") && loaded.size === 2);

  // (2) Kaputte/unbekannte Werte in der Datei werden verworfen (kein Absturz).
  mkdirSync(join(base, "b2", ".mads"), { recursive: true });
  writeFileSync(join(base, "b2", ".mads", "permissions.json"), JSON.stringify({ approvedCommandKinds: ["network", "danger", "quatsch", 42] }));
  const l2 = loadApprovedKinds(join(base, "b2"));
  check("nur bekannte, merkbare Kinds geladen", l2.has("network") && !l2.has("danger") && l2.size === 1);

  // (3) Fehlende Datei → leer, kein Fehler.
  check("kein .mads → leere Freigaben", loadApprovedKinds(join(base, "nope")).size === 0);

  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) throw new Error(`${failed} permissions test(s) failed`);
} finally {
  rmSync(base, { recursive: true, force: true });
}
