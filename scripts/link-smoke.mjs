#!/usr/bin/env node
/**
 * Rauch-Test für den Projekt-Verbund über die ECHTE Protokoll-Grenze:
 * zwei Sidecar-PROZESSE (sidecar/dist/index.js), zwei git-Repos, NDJSON auf stdin/stdout —
 * genau das, was der Rust-Core zwischen Frontend und Sidecar durchreicht.
 *
 * Was er prüft, das die Unit-/IO-Tests NICHT prüfen können: dass der Orchestrator die neuen
 * Host-Nachrichten (`link_configure`, `peer_send`, `peer_thread_action`) annimmt, den
 * LinkManager am Projekt-Lebenszyklus startet und `link_status` als gültiges NDJSON emittiert.
 *
 * Bewusst NICHT in `npm test`: er startet Prozesse und braucht git. Manuell:
 *   node scripts/link-smoke.mjs
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..");
const sandbox = mkdtempSync(join(tmpdir(), "mads-link-smoke-"));
const results = [];
let failed = 0;
const check = (name, cond) => {
  results.push(`${cond ? "PASS" : "FAIL"} ${name}`);
  if (!cond) failed++;
};
const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();

function makeRepo(name, files) {
  const root = join(sandbox, name);
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), c, "utf8");
  }
  git(root, "add", "-A");
  git(root, "commit", "-qm", "init");
  return root;
}

/** Ein Sidecar-Prozess mit NDJSON-Sprechverbindung. HOME zeigt in den Sandkasten, damit der
 *  Kanal unter <sandbox>/.mads/links landet und nicht im echten Home. */
function startSidecar(label) {
  const child = spawn("node", [join(repoRoot, "sidecar", "dist", "index.js")], {
    env: { ...process.env, HOME: sandbox },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages = [];
  const waiters = [];
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      check(`${label}: stdout ist gültiges NDJSON`, false);
      return;
    }
    messages.push(msg);
    for (const w of [...waiters]) {
      if (w.pred(msg)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(msg);
      }
    }
  });
  child.stderr.on("data", () => {}); // Logs interessieren hier nicht
  return {
    child,
    messages,
    send: (msg) => child.stdin.write(JSON.stringify({ v: 1, id: crypto.randomUUID(), ts: Date.now(), ...msg }) + "\n"),
    /** Auf die erste passende Nachricht warten (mit Zeitlimit, damit nichts ewig hängt). */
    wait: (pred, timeoutMs = 15_000) =>
      new Promise((resolve, reject) => {
        const hit = messages.find(pred);
        if (hit) return resolve(hit);
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error(`${label}: Zeitlimit beim Warten`));
        }, timeoutMs).unref();
      }),
    stop: () => child.kill("SIGKILL"),
  };
}

const serverRoot = makeRepo("shop-server", { "openapi.yaml": "paths:\n  /orders: {}\n" });
const appRoot = makeRepo("shop-app", { "Sources/Api.swift": "let api = 1\n" });

const A = startSidecar("server");
const B = startSidecar("app");

try {
  await A.wait((m) => m.type === "sidecar_ready");
  await B.wait((m) => m.type === "sidecar_ready");
  check("beide Sidecars melden sich bereit", true);

  // set_project statt open_project: kein Reconcile, keine GitHub-Aufrufe — hier geht es allein
  // um den Verbund-Pfad.
  const project = (root, repo) => ({ projectId: repo, repoRoot: root, owner: "acme", repo, defaultBranch: "main" });
  A.send({ type: "set_project", project: project(serverRoot, "shop-server") });
  B.send({ type: "set_project", project: project(appRoot, "shop-app") });

  const s0 = await A.wait((m) => m.type === "link_status");
  check("Sidecar emittiert link_status", s0.state === "none");

  A.send({
    type: "link_configure",
    config: {
      v: 1,
      peer: { repoRoot: appRoot },
      provides: { patterns: ["openapi.yaml"], compat: "additive" },
      autopilot: "assisted",
    },
  });
  const sA = await A.wait((m) => m.type === "link_status" && m.state !== "none");
  check("nach link_configure: pending (Gegenseite fehlt noch)", sA.state === "pending");
  check("Contract-Fingerprint ist berechnet", typeof sA.contract.ownFp === "string" && sA.contract.ownFp.length === 64);
  check("Auto-Detect hat openapi.yaml vorgeschlagen", (sA.suggestions ?? []).includes("openapi.yaml"));

  B.send({
    type: "link_configure",
    config: { v: 1, peer: { repoRoot: serverRoot }, provides: { patterns: [] }, autopilot: "assisted" },
  });
  const sB = await B.wait((m) => m.type === "link_status" && m.state === "active");
  check("beidseitig konfiguriert: aktiv", sB.state === "active" && sB.peer?.slug === "shop-server");

  // Der Mensch schreibt der Gegenseite — die Nachricht muss drüben als Thread ankommen.
  B.send({ type: "peer_send", text: "Bitte POST /orders/{id}/cancel ergänzen.", title: "Endpoint cancel order" });
  const arrived = await A.wait((m) => m.type === "link_status" && m.threads.length > 0, 20_000);
  const thread = arrived.threads[0];
  check("Anfrage erreicht die andere Instanz als Thread", thread.origin === "peer" && thread.kind === "request");
  check("Thread trägt einen startfähigen Auftrag", (thread.suggestedBrief ?? "").length > 0);
  await A.wait((m) => m.type === "peer_message" && m.threadId === thread.id);
  check("peer_message für die Karte wird emittiert", true);

  // Ablehnen läuft über peer_thread_action und muss beim Absender ankommen.
  A.send({ type: "peer_thread_action", threadId: thread.id, action: "decline", reason: "Anders gelöst." });
  const declined = await B.wait(
    (m) => m.type === "link_status" && m.threads.some((t) => t.id === thread.id && t.state === "declined"),
    20_000,
  );
  check("Ablehnung erreicht den Absender", !!declined);
} catch (e) {
  check(`Ablauf ohne Fehler: ${String(e)}`, false);
} finally {
  A.send({ type: "shutdown" });
  B.send({ type: "shutdown" });
  setTimeout(() => {
    A.stop();
    B.stop();
  }, 500).unref();
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(results.join("\n"));
console.log(failed === 0 ? `\n✅ link-smoke: ${results.length} Checks grün` : `\n❌ link-smoke: ${failed} Fehler`);
process.exit(failed === 0 ? 0 : 1);
