/**
 * Tests für die reine Verbund-Logik (shared/link.ts). Bewusst dependency-frei
 * (throw-basiert), lauffähig via `npm run test:link`.
 *
 * Deckt die vier Eigenschaften ab, an denen der Verbund hängt
 * (docs/design/12-project-link.md §12 „Test-Strategie"):
 *  1. Fingerprint-Determinismus (Reihenfolge-unabhängig, inhalts-sensitiv),
 *  2. Pattern-Filter (nur Contract-Dateien lösen eine Ankündigung aus),
 *  3. Thread-Zustandsmaschine (terminal ist terminal; beide Seiten gelandet ⇒ done),
 *  4. Drift-Regel + Loop-Guard (das mechanische Sicherheitsnetz).
 */
import { createHash } from "node:crypto";
import {
  LOOP_GUARD_MAX_HOPS,
  capDiff,
  contractFingerprint,
  contractFpInput,
  filterContractDelta,
  isDrift,
  landOrderWarning,
  linkIdFor,
  linkRole,
  linkState,
  loopGuardOk,
  matchesContract,
  newThread,
  normalizeLinkConfig,
  pendingThreads,
  presenceOnline,
  shouldAutoDispatch,
  slugFor,
  suggestContractPatterns,
  threadReducer,
  CONTRACT_DIFF_CAP,
} from "./link";
import type { LinkPresence, LinkThread } from "./protocol";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const results: string[] = [];
let failed = 0;
function check(name: string, cond: boolean): void {
  results.push(`${cond ? "PASS" : "FAIL"} ${name}`);
  if (!cond) failed++;
}

// ─── 1. Fingerprint ──────────────────────────────────────────────────────────
{
  const a = [
    { path: "openapi.yaml", sha: "aaa" },
    { path: "src/api/routes/orders.ts", sha: "bbb" },
  ];
  const b = [
    { path: "src/api/routes/orders.ts", sha: "bbb" },
    { path: "openapi.yaml", sha: "aaa" },
  ];
  check("Fingerprint ist reihenfolge-unabhängig", contractFingerprint(a, sha256) === contractFingerprint(b, sha256));
  check(
    "Fingerprint ändert sich bei geändertem Blob",
    contractFingerprint(a, sha256) !== contractFingerprint([{ path: "openapi.yaml", sha: "zzz" }, a[1]], sha256),
  );
  check(
    "Fingerprint ändert sich bei NEUER Contract-Datei",
    contractFingerprint(a, sha256) !== contractFingerprint([...a, { path: "schema.graphql", sha: "ccc" }], sha256),
  );
  check("leerer Contract ⇒ leerer Fingerprint (reiner Consumer)", contractFingerprint([], sha256) === "");
  check("kanonische Eingabe ist sortiert", contractFpInput(b) === "openapi.yaml aaa\nsrc/api/routes/orders.ts bbb");
}

// ─── 2. Pattern-Filter ───────────────────────────────────────────────────────
{
  const patterns = ["openapi.yaml", "src/api/routes/**"];
  check("exakter Treffer", matchesContract("openapi.yaml", patterns));
  check("Glob über Segmente", matchesContract("src/api/routes/v2/orders.ts", patterns));
  check("Nicht-Contract-Datei zählt nicht", !matchesContract("src/ui/Button.tsx", patterns));

  const regions = [
    { path: "openapi.yaml", symbols: [] },
    { path: "src/api/routes/orders.ts", symbols: ["cancelOrder"] },
    { path: "src/ui/Button.tsx", symbols: ["Button"] },
  ];
  const delta = filterContractDelta(regions, patterns);
  check("Filter behält nur Contract-Pfade", delta.length === 2 && !delta.some((r) => r.path.startsWith("src/ui/")));
  check("ohne Muster (reiner Consumer) ist der Filter leer", filterContractDelta(regions, []).length === 0);

  const big = "x".repeat(CONTRACT_DIFF_CAP + 10);
  check("Diff-Cap greift und ist SICHTBAR", capDiff(big).truncated && capDiff(big).diff.length === CONTRACT_DIFF_CAP);
  check("kleiner Diff bleibt unangetastet", !capDiff("abc").truncated && capDiff("abc").diff === "abc");
}

// ─── 3. Thread-Zustandsmaschine ──────────────────────────────────────────────
const now = 1_757_000_000_000;
function mk(overrides: Partial<LinkThread> = {}): LinkThread {
  return { ...newThread({ id: "T1", origin: "peer", kind: "contract_change", title: "cancel-order", now }), ...overrides };
}
{
  let t = mk();
  check("frischer Thread ist offen", t.state === "open" && t.hops === 0);

  t = threadReducer(t, { kind: "proposed", label: "Client nachziehen", brief: "…" }, now + 1);
  check("Proposal → proposed", t.state === "proposed" && t.proposal?.label === "Client nachziehen");

  t = threadReducer(t, { kind: "started", ownerAgentId: "sub-7" }, now + 2);
  check("Start → in_progress mit Owner", t.state === "in_progress" && t.ownerAgentId === "sub-7");

  t = threadReducer(t, { kind: "landed", sha: "3e2f1a9c" }, now + 3);
  check("gelandet, aber Gegenseite offen ⇒ landed", t.state === "landed");

  t = threadReducer(t, { kind: "peer_done", sha: "7c1d0000" }, now + 4);
  check("beide Seiten gelandet ⇒ done", t.state === "done" && t.peerLanded === true);

  const after = threadReducer(t, { kind: "started", ownerAgentId: "sub-9" }, now + 5);
  check("done ist terminal (started prallt ab)", after.state === "done" && after.ownerAgentId === "sub-7");

  const reopened = threadReducer(t, { kind: "reopened" }, now + 6);
  check("reopened holt einen terminalen Thread zurück", reopened.state === "in_progress");

  const declined = threadReducer(mk(), { kind: "declined", reason: "nicht nötig" }, now + 1);
  check("declined ist terminal", threadReducer(declined, { kind: "proposed", label: "x", brief: "y" }, now + 2).state === "declined");
  check(
    "declined lässt sich per Nachsenden NICHT aushebeln",
    threadReducer(declined, { kind: "peer_update", text: "nochmal" }, now + 3).state === "declined",
  );

  const bumped = threadReducer(mk(), { kind: "peer_update", text: "Provider hat geliefert" }, now + 1);
  check("peer_update erhöht den Hop-Zähler", bumped.hops === 1);
  check("Log wächst monoton", bumped.log.length === 1 && bumped.log[0].who === "peer");

  // Log-Kappung: 60 Notizen → höchstens 50 bleiben.
  let many = mk();
  for (let i = 0; i < 60; i++) many = threadReducer(many, { kind: "note", text: `n${i}`, who: "local" }, now + i);
  check("Log ist auf 50 Einträge gekappt", many.log.length === 50 && many.log[49].text === "n59");
}

// ─── 4. Drift-Regel ──────────────────────────────────────────────────────────
{
  const open = mk({ contractFp: "fp-neu", state: "in_progress" });
  const closed = mk({ contractFp: "fp-neu", state: "done" });
  check("kein Peer-Fingerprint ⇒ keine Drift", !isDrift({ peerFp: undefined, ackedFp: "x", threads: [] }));
  check("nachvollzogener Stand ⇒ keine Drift", !isDrift({ peerFp: "fp-neu", ackedFp: "fp-neu", threads: [] }));
  check("offener Thread erklärt den Stand ⇒ keine Drift", !isDrift({ peerFp: "fp-neu", ackedFp: "fp-alt", threads: [open] }));
  check("nur ein GESCHLOSSENER Thread ⇒ Drift", isDrift({ peerFp: "fp-neu", ackedFp: "fp-alt", threads: [closed] }));
  check("gar kein Thread ⇒ Drift (Sicherheitsnetz)", isDrift({ peerFp: "fp-neu", ackedFp: "fp-alt", threads: [] }));
  check(
    "wartende Threads für das Badge",
    pendingThreads([mk(), mk({ state: "in_progress" }), mk({ state: "escalated" })]).length === 2,
  );
}

// ─── 5. Loop-Guard & Dispatch-Stufen ─────────────────────────────────────────
{
  check("unter der Schwelle darf dispatcht werden", loopGuardOk(LOOP_GUARD_MAX_HOPS - 1));
  check("auf der Schwelle nicht mehr", !loopGuardOk(LOOP_GUARD_MAX_HOPS));
  check("autopilot dispatcht selbst", shouldAutoDispatch("autopilot", 0));
  check("assisted wartet auf den Menschen", !shouldAutoDispatch("assisted", 0));
  check("manual ebenfalls", !shouldAutoDispatch("manual", 0));
  check("autopilot stoppt am Loop-Guard", !shouldAutoDispatch("autopilot", LOOP_GUARD_MAX_HOPS));
}

// ─── 6. Gegenseitiges Einverständnis / Zustand ───────────────────────────────
{
  const alive = () => true;
  const dead = () => false;
  const base: LinkPresence = {
    pid: 4711,
    ts: now,
    slug: "shop-app",
    repoRoot: "/Users/me/coding/shop-app",
    provides: [],
    compat: "additive",
    peerRepoRoot: "/Users/me/coding/shop-server",
    protocolVersion: 1,
    linkVersion: 1,
  };
  const config = normalizeLinkConfig({ v: 1, peer: { repoRoot: "/Users/me/coding/shop-app" }, provides: { patterns: ["openapi.yaml"] } })!;
  const own = "/Users/me/coding/shop-server";

  check("ohne Konfiguration: none", linkState({ ownRepoRoot: own, now, pidAlive: alive }).state === "none");
  check(
    "ohne Presence der Gegenseite: pending",
    linkState({ config, ownRepoRoot: own, now, pidAlive: alive }).state === "pending",
  );
  check(
    "Gegenseite nennt ein ANDERES Repo: pending (kein Unterschieben)",
    linkState({ config, ownRepoRoot: own, peerPresence: { ...base, peerRepoRoot: "/other" }, now, pidAlive: alive }).state === "pending",
  );
  check(
    "beidseitig genannt + Prozess lebt: active",
    linkState({ config, ownRepoRoot: own, peerPresence: base, now, pidAlive: alive }).state === "active",
  );
  check(
    "toter Prozess: peer_offline",
    linkState({ config, ownRepoRoot: own, peerPresence: base, now, pidAlive: dead }).state === "peer_offline",
  );
  check(
    "veralteter Heartbeat: peer_offline",
    linkState({ config, ownRepoRoot: own, peerPresence: { ...base, ts: now - 60_000 }, now, pidAlive: alive }).state === "peer_offline",
  );
  check(
    "fremde LINK_VERSION: pending mit Hinweis",
    linkState({ config, ownRepoRoot: own, peerPresence: { ...base, linkVersion: 2 }, now, pidAlive: alive }).state === "pending",
  );
  check("Presence-Frische zählt Prozess UND Alter", presenceOnline(base, now, alive) && !presenceOnline(base, now + 60_000, alive));
}

// ─── 7. Rollen, Landing-Reihenfolge, Identität, Konfiguration ────────────────
{
  check("eigene Muster, Peer ohne ⇒ Provider", linkRole(["openapi.yaml"], []) === "provider");
  check("keine eigenen Muster ⇒ Consumer", linkRole([], ["openapi.yaml"]) === "consumer");
  check("beide ⇒ bidirektional", linkRole(["a"], ["b"]) === "bidirectional");

  const peerOpen = mk({ origin: "peer", kind: "contract_change", state: "in_progress" });
  check("additive: Warnung, aber nicht schwer", landOrderWarning([peerOpen], "additive")?.severe === false);
  check("lockstep: Warnung ist schwer", landOrderWarning([peerOpen], "lockstep")?.severe === true);
  check(
    "gelandete Gegenseite warnt nicht mehr",
    landOrderWarning([{ ...peerOpen, peerLanded: true }], "lockstep") === undefined,
  );

  check(
    "linkId ist symmetrisch",
    linkIdFor("/a/shop-server", "/a/shop-app", sha256) === linkIdFor("/a/shop-app", "/a/shop-server", sha256),
  );
  check("linkId ist kurz und stabil", linkIdFor("/a", "/b", sha256).length === 12);
  check("Slug ist dateisystem-sicher", slugFor("/Users/me/coding/shop server/") === "shop-server");

  check("Konfiguration ohne Peer wird verworfen", normalizeLinkConfig({ v: 1, provides: { patterns: [] } }) === undefined);
  const norm = normalizeLinkConfig({
    v: 1,
    peer: { repoRoot: " /x/y " },
    provides: { patterns: ["a", "a", " ", "b"], compat: "quatsch" },
    autopilot: "unsinn",
  })!;
  check("Muster werden entdoppelt und getrimmt", norm.provides.patterns.join(",") === "a,b");
  check("unbekannter compat fällt auf additive", norm.provides.compat === "additive");
  check("unbekannte Autopilot-Stufe fällt auf assisted", norm.autopilot === "assisted");

  const sugg = suggestContractPatterns(["openapi.yaml", "src/api/routes/orders.ts", "src/ui/App.tsx", "schema.graphql"]);
  check("Auto-Detect erkennt openapi + graphql", sugg.includes("openapi.yaml") && sugg.includes("schema.graphql"));
  check("Auto-Detect schlägt Routen-Glob vor", sugg.includes("src/api/routes/**"));
  check("Auto-Detect schlägt keine UI-Dateien vor", !sugg.some((s) => s.startsWith("src/ui")));
}

console.log(results.join("\n"));
console.log(failed === 0 ? `\n✅ link: ${results.length} Checks grün` : `\n❌ link: ${failed} Fehler`);
if (failed > 0) process.exit(1);
