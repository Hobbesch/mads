#!/usr/bin/env node
// mads-handoff — den KOMPLETTEN Arbeitsstand eines Projekts (alle Streams: Code inkl. uncommitteter
// Arbeit, Registry, Chat-Verläufe UND die Claude-Sessions für echtes --resume) in EINE portable
// Datei packen und auf einem anderen Rechner wiederherstellen → nahtlos weiterarbeiten.
//
// Kein GitHub nötig: der Code reist als `git bundle` (alle Refs mit Historie) mit.
//
// Nutzung:
//   node mads-handoff.mjs export <repoRoot> <out.tar.gz>
//   node mads-handoff.mjs import <in.tar.gz> [zielRepoRoot] [zielWorktreeBase]
//
// Gleicher Benutzername auf beiden Macs → alles verbatim (Pfade + Session-Keys identisch).
// Anderer Benutzer/Pfad → Import „homed" Worktree-Pfade, Registry UND Session-Keys automatisch um.
//
// Test-Schalter: MADS_HANDOFF_CLAUDE_DIR überschreibt ~/.claude/projects (isolierter Round-Trip).

import { execFileSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync, readdirSync, statSync,
} from "node:fs";
import { tmpdir, homedir, userInfo } from "node:os";
import { join, basename, dirname } from "node:path";

const HANDOFF_VERSION = 1;

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"], ...opts });
const shq = (cmd, args, opts = {}) => { try { return sh(cmd, args, opts); } catch { return null; } };
const log = (...a) => console.log(...a);
const die = (m) => { console.error("✗ " + m); process.exit(1); };

/** Claude-Code-Session-Ordnerschlüssel aus einem absoluten cwd: schlicht jedes `/` → `-`. */
const encodeCwd = (p) => p.replaceAll("/", "-");
const claudeProjectsDir = () => process.env.MADS_HANDOFF_CLAUDE_DIR || join(homedir(), ".claude", "projects");

// ───────────────────────────────────────────────────────────── EXPORT
function doExport(repoRootArg, outFile) {
  const repoRoot = repoRootArg.replace(/\/+$/, "");
  if (!existsSync(join(repoRoot, ".git"))) die(`Kein git-Repo: ${repoRoot}`);
  const regPath = join(repoRoot, ".mads", "agents.json");
  if (!existsSync(regPath)) die(`Keine Registry: ${regPath}`);

  const registry = JSON.parse(readFileSync(regPath, "utf8"));
  const agents = Array.isArray(registry.agents) ? registry.agents : [];
  const defaultBranch = shq("git", ["-C", repoRoot, "symbolic-ref", "--short", "HEAD"])?.trim() || "main";
  const projDir = claudeProjectsDir();
  const home = homedir();

  const stage = mkdtempSync(join(tmpdir(), "mads-handoff-"));
  mkdirSync(join(stage, "transcripts"), { recursive: true });
  mkdirSync(join(stage, "patches"), { recursive: true });
  mkdirSync(join(stage, "sessions"), { recursive: true });

  // Registry + Chat-Verläufe
  cpSync(regPath, join(stage, "agents.json"));
  const tdir = join(repoRoot, ".mads", "transcripts");
  if (existsSync(tdir)) cpSync(tdir, join(stage, "transcripts"), { recursive: true });

  // origin-URL + zu bündelnde Branches vormerken. Das Bundle selbst entsteht NACH dem Auslesen der
  // Worktree-HEADs (unten) — inkl. der konkreten HEAD-Commits, damit auch währenddessen committete
  // Stände sicher enthalten sind (Race mit laufenden Agenten).
  const streamBranches = [...new Set(agents.map((a) => a.branch).filter(Boolean))]
    .filter((b) => shq("git", ["-C", repoRoot, "rev-parse", "--verify", "--quiet", `refs/heads/${b}`]) !== null);
  const originUrl = shq("git", ["-C", repoRoot, "remote", "get-url", "origin"])?.trim() || null;

  const allProj = existsSync(projDir) ? readdirSync(projDir) : [];
  const streams = [];
  let sessionCount = 0;

  for (const a of agents) {
    const wt = a.worktreePath;
    const s = { agentId: a.agentId, label: a.label ?? null, branch: a.branch ?? null,
                sessionId: a.sessionId ?? null, worktreePath: wt ?? null, status: a.status ?? null,
                head: null, tracked: false, untracked: 0, sessionDirs: [] };
    if (wt && existsSync(wt)) {
      s.head = shq("git", ["-C", wt, "rev-parse", "HEAD"])?.trim() ?? null;
      // uncommittete, getrackte Änderungen (vs HEAD)
      const patch = shq("git", ["-C", wt, "diff", "HEAD"]);
      if (patch && patch.trim()) { writeFileSync(join(stage, "patches", `${a.agentId}.tracked.patch`), patch); s.tracked = true; }
      // ungetrackte Dateien (respektiert .gitignore → kein node_modules)
      const others = shq("git", ["-C", wt, "ls-files", "--others", "--exclude-standard", "-z"]);
      if (others && others.length) {
        const files = others.split("\0").filter(Boolean);
        if (files.length) {
          const listFile = join(stage, "patches", `${a.agentId}.untracked.list`);
          writeFileSync(listFile, files.join("\n"));
          sh("tar", ["-czf", join(stage, "patches", `${a.agentId}.untracked.tar.gz`), "-C", wt, "-T", listFile]);
          s.untracked = files.length;
        }
      }
      // Claude-Sessions dieses Worktrees (inkl. Unter-cwds wie …-client)
      const enc = encodeCwd(wt);
      for (const d of allProj) {
        if (d === enc || d.startsWith(enc + "-")) {
          cpSync(join(projDir, d), join(stage, "sessions", d), { recursive: true });
          s.sessionDirs.push(d);
          sessionCount++;
        }
      }
    }
    streams.push(s);
  }

  // Jetzt sind alle HEADs gelesen → Bundle mit defaultBranch + Stream-Branches + den KONKRETEN
  // HEAD-Commits (letztere schließen die Race mit laufenden Agenten sicher aus).
  const heads = [...new Set(streams.map((s) => s.head).filter(Boolean))];
  log(`• git bundle (${defaultBranch} + ${streamBranches.length} Branches + ${heads.length} HEADs) …`);
  sh("git", ["-C", repoRoot, "bundle", "create", join(stage, "repo.bundle"), "HEAD", defaultBranch, ...streamBranches, ...heads]);

  const wtBase = streams.find((s) => s.worktreePath) ? dirname(streams.find((s) => s.worktreePath).worktreePath) : null;
  const manifest = {
    version: HANDOFF_VERSION,
    createdAt: new Date().toISOString(),
    sourceUser: userInfo().username,
    sourceHome: home,
    repoRoot, project: basename(repoRoot), defaultBranch, worktreeBase: wtBase, originUrl,
    streams,
  };
  writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2));

  log("• packe …");
  sh("tar", ["-czf", outFile, "-C", stage, "."]);
  rmSync(stage, { recursive: true, force: true });

  const sz = (statSync(outFile).size / 1e6).toFixed(1);
  log(`\n✓ Handoff geschrieben: ${outFile} (${sz} MB)`);
  log(`  Streams: ${streams.length} · mit Session: ${streams.filter((s) => s.sessionDirs.length).length} · Session-Ordner: ${sessionCount}`);
  log(`  Uncommittet: ${streams.filter((s) => s.tracked || s.untracked).map((s) => s.agentId.slice(0, 8)).join(", ") || "—"}`);
}

// ───────────────────────────────────────────────────────────── IMPORT
function doImport(bundleFile, targetRepoRootArg, targetWtBaseArg) {
  if (!existsSync(bundleFile)) die(`Datei fehlt: ${bundleFile}`);
  const stage = mkdtempSync(join(tmpdir(), "mads-handoff-in-"));
  sh("tar", ["-xzf", bundleFile, "-C", stage]);
  const manifest = JSON.parse(readFileSync(join(stage, "manifest.json"), "utf8"));
  const home = homedir();
  const targetUser = userInfo().username;
  const verbatim = !targetRepoRootArg && !targetWtBaseArg && manifest.sourceUser === targetUser;

  const repoRoot = (targetRepoRootArg || (verbatim ? manifest.repoRoot : join(home, "Documents", "coding", manifest.project))).replace(/\/+$/, "");
  const wtBase = targetWtBaseArg || (verbatim ? manifest.worktreeBase : join(home, "mads-worktrees", manifest.project));
  const projDir = claudeProjectsDir();
  const homeWt = (agentId, srcWt) => (verbatim ? srcWt : join(wtBase, agentId));

  log(`• Ziel-Repo: ${repoRoot}`);
  log(`• Worktree-Basis: ${wtBase}${verbatim ? "  (verbatim)" : "  (re-homed)"}`);

  // 1) Repo herstellen (aus dem Bundle — kein GitHub nötig). Die konkreten HEAD-Commits müssen danach
  //    im Objektstore sein, damit `worktree add <head>` klappt.
  const bundlePath = join(stage, "repo.bundle");
  const freshClone = !existsSync(join(repoRoot, ".git"));
  if (freshClone) {
    mkdirSync(dirname(repoRoot), { recursive: true });
    log("• klone Repo aus dem Bundle …");
    sh("git", ["clone", bundlePath, repoRoot]);
    // Ein Bundle-Klon checkt bei mehreren Branches auf DEMSELBEN HEAD-Commit evtl. einen beliebigen
    // (mads/*) Branch aus statt main → Haupt-Worktree hart auf defaultBranch setzen. Sonst ist dessen
    // Branch „already checked out" (worktree add scheitert) und `main` fehlt lokal.
    shq("git", ["-C", repoRoot, "checkout", "-B", manifest.defaultBranch, `refs/remotes/origin/${manifest.defaultBranch}`]);
    // origin zeigt nach dem Klon auf die Bundle-Datei → auf das echte GitHub-Remote umbiegen.
    if (manifest.originUrl) {
      shq("git", ["-C", repoRoot, "remote", "set-url", "origin", manifest.originUrl]);
      log(`  origin → ${manifest.originUrl}`);
    }
  } else {
    // Vorhandenes Repo: NUR Objekte + Refs in einen Sicherheits-Namespace (refs/handoff/*) holen —
    // fasst weder das (evtl. ausgecheckte) main noch bestehende lokale Branches an. Die Stream-Branches
    // entstehen unten via `worktree add -B`; die HEAD-Commits sind durch den Fetch vorhanden.
    log("• Repo vorhanden → Objekte aus dem Bundle holen (refs/handoff/*) …");
    sh("git", ["-C", repoRoot, "fetch", bundlePath, "+refs/heads/*:refs/handoff/*"]);
  }

  // 2) Streams: Worktree + uncommittete Arbeit + Sessions
  mkdirSync(projDir, { recursive: true });
  mkdirSync(wtBase, { recursive: true });
  let restoredSessions = 0;
  for (const s of manifest.streams) {
    if (!s.branch || !s.head) continue;
    const wtPath = homeWt(s.agentId, s.worktreePath);
    if (!existsSync(wtPath)) {
      const r = shq("git", ["-C", repoRoot, "worktree", "add", "-B", s.branch, wtPath, s.head]);
      if (r === null) { log(`  ⚠ Worktree ${s.agentId.slice(0, 8)} (${s.branch}) konnte nicht angelegt werden — übersprungen`); continue; }
    }
    // uncommittete Arbeit
    const tp = join(stage, "patches", `${s.agentId}.tracked.patch`);
    if (existsSync(tp)) { if (shq("git", ["-C", wtPath, "apply", "--whitespace=nowarn", tp]) === null) log(`  ⚠ Patch für ${s.agentId.slice(0, 8)} nicht sauber anwendbar`); }
    const ut = join(stage, "patches", `${s.agentId}.untracked.tar.gz`);
    if (existsSync(ut)) sh("tar", ["-xzf", ut, "-C", wtPath]);
    // Claude-Sessions re-homen (Ordnername + cwd-Referenzen)
    const srcEnc = encodeCwd(s.worktreePath ?? ""), dstEnc = encodeCwd(wtPath);
    for (const d of s.sessionDirs ?? []) {
      const src = join(stage, "sessions", d);
      if (!existsSync(src)) continue;
      const dstName = dstEnc + d.slice(srcEnc.length); // erhält Unter-cwd-Suffix (…-client)
      const dst = join(projDir, dstName);
      cpSync(src, dst, { recursive: true });
      if (!verbatim && s.worktreePath && s.worktreePath !== wtPath) {
        for (const f of readdirSync(dst)) {
          if (f.endsWith(".jsonl")) {
            const p = join(dst, f);
            writeFileSync(p, readFileSync(p, "utf8").split(s.worktreePath).join(wtPath));
          }
        }
      }
      restoredSessions++;
    }
  }

  // Sicherheits-Namespace refs/handoff/* wieder aufräumen (nur im „Repo vorhanden"-Fall angelegt).
  if (!freshClone) {
    for (const r of (shq("git", ["-C", repoRoot, "for-each-ref", "--format=%(refname)", "refs/handoff"]) || "").split("\n").filter(Boolean)) {
      shq("git", ["-C", repoRoot, "update-ref", "-d", r]);
    }
  }

  // 3) .mads: Registry (Pfade re-homed) + Transcripts
  const madsDir = join(repoRoot, ".mads");
  mkdirSync(join(madsDir, "transcripts"), { recursive: true });
  const reg = JSON.parse(readFileSync(join(stage, "agents.json"), "utf8"));
  if (Array.isArray(reg.agents) && !verbatim) {
    for (const a of reg.agents) if (a.worktreePath) a.worktreePath = join(wtBase, a.agentId);
  }
  writeFileSync(join(madsDir, "agents.json"), JSON.stringify(reg, null, 2));
  const tdir = join(stage, "transcripts");
  if (existsSync(tdir)) cpSync(tdir, join(madsDir, "transcripts"), { recursive: true });

  rmSync(stage, { recursive: true, force: true });
  log(`\n✓ Import fertig → ${repoRoot}`);
  log(`  Streams wiederhergestellt: ${manifest.streams.filter((s) => s.head).length} · Sessions: ${restoredSessions}`);
  log(`  Öffne dieses Projekt in mads → alle Streams erscheinen als fortsetzbar (mit vollem Kontext).`);
}

// ───────────────────────────────────────────────────────────── CLI
const [, , cmd, a1, a2, a3] = process.argv;
if (cmd === "export" && a1 && a2) doExport(a1, a2);
else if (cmd === "import" && a1) doImport(a1, a2, a3);
else {
  console.error("Nutzung:\n  mads-handoff.mjs export <repoRoot> <out.tar.gz>\n  mads-handoff.mjs import <in.tar.gz> [zielRepoRoot] [zielWorktreeBase]");
  process.exit(2);
}
