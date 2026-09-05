import { existsSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractAuthUrl,
  extractToken,
  resolveClaudeBin,
  sameAccount,
  AccountRelink,
  type RelinkUpdate,
} from "./accountRelink.js";

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

// ---- sameAccount: die Prüfung, um derentwillen es den Flow gibt --------------------------------
// Gemessene Echtwerte vom 05.09.2026: die beiden Konten auf diesem Rechner unterscheiden sich im
// Wochenfenster (09.09. vs. 11.09.). Genau darauf stützt sich die Erkennung.
const PBX = { fiveHourReset: 1788602400, sevenDayReset: 1788962400 };
const MED = { fiveHourReset: 1788615000, sevenDayReset: 1789146000 };

check("identische Fenster → dasselbe Konto", sameAccount(PBX, { ...PBX }));
check("verschiedene Konten werden unterschieden", !sameAccount(PBX, MED));
check(
  "gleiches Wochenfenster, anderes 5h-Fenster → NICHT dasselbe Konto",
  !sameAccount(PBX, { ...PBX, fiveHourReset: 1788615000 }),
);
// Lieber gar keine Warnung als eine falsche: eine erfundene Gleichheit hielte den Menschen von
// einer richtigen Konfiguration ab.
check("fehlendes Wochenfenster → keine Behauptung", !sameAccount({ fiveHourReset: 1 }, { fiveHourReset: 1 }));
check("fehlendes 5h-Fenster → keine Behauptung", !sameAccount({ sevenDayReset: 9 }, { sevenDayReset: 9 }));
check("leere Fingerabdrücke → keine Behauptung", !sameAccount({}, {}));

// ---- Ausgabe-Parser: dürfen sich an ändernden Text anpassen ------------------------------------
check(
  "Authorize-URL wird gefunden",
  extractAuthUrl("Opening browser: https://claude.ai/oauth/authorize?code=1&x=2 …") ===
    "https://claude.ai/oauth/authorize?code=1&x=2",
);
check("URL ohne 'oauth' im Pfad wird trotzdem gefunden", !!extractAuthUrl("Visit https://claude.ai/login/abc to continue"));
check("Zeile ohne URL liefert undefined", extractAuthUrl("Paste code here:") === undefined);
check(
  "Token wird aus der Ausgabe gefischt",
  extractToken("Your token:\nsk-ant-oat01-AAAAbbbbCCCCddddEEEEffff\n") === "sk-ant-oat01-AAAAbbbbCCCCddddEEEEffff",
);
check("zu kurze Zeichenkette ist kein Token", extractToken("sk-ant-oat01-kurz") === undefined);
check("Text ohne Token liefert undefined", extractToken("Anmeldung abgebrochen") === undefined);

// ---- resolveClaudeBin: Übersteuerung gewinnt (und macht den Flow testbar) ----------------------
const prevBin = process.env.MADS_CLAUDE_BIN;
process.env.MADS_CLAUDE_BIN = "/pfad/zu/claude";
check("MADS_CLAUDE_BIN übersteuert", resolveClaudeBin() === "/pfad/zu/claude");
delete process.env.MADS_CLAUDE_BIN;
check("ohne Übersteuerung wird etwas aufgelöst", resolveClaudeBin().length > 0);

// ---- Flow gegen ein FAKE setup-token: prüft die Verdrahtung ohne echte Anmeldung ---------------
// Der Fake druckt eine URL, wartet auf den Code und antwortet dann. Er ersetzt genau das, was in
// einem Test nicht geht (eine echte OAuth-Anmeldung) — der Rest ist der Produktionspfad.
const dir = join(tmpdir(), `mads-relink-test-${process.pid}`);
mkdirSync(dir, { recursive: true });
const fake = join(dir, "fake-claude.sh");
writeFileSync(
  fake,
  ["#!/bin/sh", 'echo "Opening browser: https://claude.ai/oauth/authorize?fake=1"', "read code", 'echo "got:$code"', "exit 7"].join("\n"),
);
chmodSync(fake, 0o755);

const updates: RelinkUpdate[] = [];
const flow = new AccountRelink((u) => updates.push(u));
process.env.MADS_CLAUDE_BIN = fake;

// Unbekanntes Konto darf NICHT stillschweigend nichts tun — sonst dreht sich in der UI ewig ein
// Spinner, den niemand mehr erklärt bekommt.
flow.start("gibtsnicht");
check(
  "unbekanntes Konto meldet sofort einen Fehler",
  updates.length === 1 && updates[0].phase === "error" && updates[0].accountId === "gibtsnicht",
);

const realId = (await import("./accounts.js")).loadAccounts().profiles[0]?.id;
if (realId) {
  updates.length = 0;
  flow.start(realId);
  await new Promise((r) => setTimeout(r, 900));
  check("Flow meldet zuerst 'starting'", updates[0]?.phase === "starting");
  const awaiting = updates.find((u) => u.phase === "awaiting_code");
  check("Authorize-URL erreicht die Oberfläche", awaiting?.url === "https://claude.ai/oauth/authorize?fake=1");

  flow.submitCode("  test-code  ");
  await new Promise((r) => setTimeout(r, 900));
  check("nach dem Code wird 'verifying' gemeldet", updates.some((u) => u.phase === "verifying"));
  // Der Fake liefert keinen Token → der Flow MUSS mit einem Fehler enden und darf nichts schreiben.
  const last = updates[updates.length - 1];
  check("ohne Token endet der Flow im Fehler (nichts wird gespeichert)", last?.phase === "error");
  check("die Fehlermeldung nennt den Grund", (last?.message ?? "").length > 10);
} else {
  console.log("SKIP Flow-Durchlauf (keine Konten-Registry auf diesem Rechner)");
}

flow.cancel();
if (prevBin === undefined) delete process.env.MADS_CLAUDE_BIN;
else process.env.MADS_CLAUDE_BIN = prevBin;
if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) throw new Error(`${failed} accountRelink test(s) failed`);
