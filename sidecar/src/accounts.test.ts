import { DEFAULT_ACCOUNT_ID, earliestReset, inCooldown, pickFallback, pruneCooldowns, resolveProfile, withCooldown } from "./accounts.js";
import type { AccountsState } from "../../shared/protocol.js";

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

const NOW = 1_700_000_000_000;
const HOUR = 3600_000;

function state(): AccountsState {
  return {
    profiles: [
      { id: DEFAULT_ACCOUNT_ID, label: "Standard", configDir: "/Users/x/.claude" },
      { id: "zweit", label: "Zweitkonto", configDir: "/Users/x/.claude-zweit" },
    ],
    activeId: DEFAULT_ACCOUNT_ID,
    cooldowns: {},
  };
}

// ---- resolveProfile: darf NIE undefined liefern (sonst stünde ein Stream ohne Config-Dir da) ----
check("bekannte ID wird aufgelöst", resolveProfile(state(), "zweit").configDir === "/Users/x/.claude-zweit");
check("unbekannte ID → aktives Konto", resolveProfile(state(), "gibtsnicht").id === DEFAULT_ACCOUNT_ID);
check("ohne ID → aktives Konto", resolveProfile(state(), undefined).id === DEFAULT_ACCOUNT_ID);
check(
  "aktives Konto unbekannt → erstes Profil (nie undefined)",
  resolveProfile({ ...state(), activeId: "weg" }, undefined).id === DEFAULT_ACCOUNT_ID,
);

// ---- Cooldown ----
const rejected = withCooldown(state(), DEFAULT_ACCOUNT_ID, { until: NOW + HOUR, rejected: true, window: "five_hour" });
check("abgewiesenes Konto ist im Cooldown", inCooldown(rejected, DEFAULT_ACCOUNT_ID, NOW));
check("anderes Konto bleibt frei", !inCooldown(rejected, "zweit", NOW));
check("abgelaufener Cooldown zählt nicht mehr", !inCooldown(rejected, DEFAULT_ACCOUNT_ID, NOW + 2 * HOUR));

const warned = withCooldown(state(), DEFAULT_ACCOUNT_ID, { until: NOW + HOUR, rejected: false });
check(
  "blosse VORWARNUNG sperrt nicht (Konto läuft ja noch)",
  !inCooldown(warned, DEFAULT_ACCOUNT_ID, NOW),
);

// ---- pickFallback: das Ausweich-Konto für das Umschalt-Angebot ----
check("Ausweichkonto wird gefunden", pickFallback(rejected, DEFAULT_ACCOUNT_ID, NOW)?.id === "zweit");
check("nie dasselbe Konto vorschlagen", pickFallback(state(), DEFAULT_ACCOUNT_ID, NOW)?.id === "zweit");
const bothDown = withCooldown(rejected, "zweit", { until: NOW + 3 * HOUR, rejected: true });
check(
  "beide im Cooldown → kein Vorschlag (statt falscher Hoffnung)",
  pickFallback(bothDown, DEFAULT_ACCOUNT_ID, NOW) === undefined,
);
check(
  "einzelnes Profil → kein Vorschlag",
  pickFallback({ ...state(), profiles: [state().profiles[0]] }, DEFAULT_ACCOUNT_ID, NOW) === undefined,
);

// ---- earliestReset: was die UI anzeigt, wenn nichts frei ist ----
check("frühester Reset über beide Cooldowns", earliestReset(bothDown, NOW) === NOW + HOUR);
check("ohne Cooldowns kein Reset-Zeitpunkt", earliestReset(state(), NOW) === undefined);
check(
  "Vorwarnungen zählen nicht als Reset-Grund",
  earliestReset(warned, NOW) === undefined,
);

// ---- pruneCooldowns ----
const mixed = withCooldown(bothDown, "alt", { until: NOW - HOUR, rejected: true });
check("abgelaufene Einträge fliegen raus", pruneCooldowns(mixed, NOW).cooldowns.alt === undefined);
check("laufende Einträge bleiben", Object.keys(pruneCooldowns(mixed, NOW).cooldowns).length === 2);
check("nichts zu tun → identische Referenz (kein unnötiges Schreiben)", pruneCooldowns(bothDown, NOW) === bothDown);

// ---- Unveränderlichkeit: withCooldown darf den Eingangszustand nicht mutieren ----
const before = state();
withCooldown(before, "zweit", { until: NOW + HOUR, rejected: true });
check("withCooldown mutiert den Ausgangszustand nicht", Object.keys(before.cooldowns).length === 0);

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) throw new Error(`${failed} accounts test(s) failed`);
