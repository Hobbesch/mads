#!/usr/bin/env node
/**
 * Baut sidecar/dist/index.js und stempelt den aktuellen Git-Commit ein (__SIDECAR_GIT_COMMIT__ /
 * __SIDECAR_GIT_DIRTY__) — die einzige Quelle, aus der src/index.ts (checkBuildDrift) erkennt, ob
 * ein laufender Sidecar-Prozess älter ist als main. Gleiches Muster wie vite.config.ts fürs
 * Frontend (siehe src/vite-env.d.ts / src/version.ts) — zwei unabhängige Build-Stempel, weil
 * Sidecar (esbuild/Node) und Frontend (Vite) getrennt gebaut und der Sidecar-Build allein per
 * npm-Script ohne Reinstall aktualisiert werden kann (installiertes mads.app führt dist/index.js
 * direkt aus dem Repo aus).
 */
import { execFileSync } from "node:child_process";
import { build } from "esbuild";

function git(args, fallback) {
  try {
    return execFileSync("git", args, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || fallback;
  } catch {
    return fallback;
  }
}

const commit = git(["rev-parse", "--short", "HEAD"], "unknown");
const dirty = git(["status", "--porcelain"], "") !== "";

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
  outfile: "dist/index.js",
  banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" },
  define: {
    __SIDECAR_GIT_COMMIT__: JSON.stringify(commit),
    __SIDECAR_GIT_DIRTY__: JSON.stringify(dirty),
  },
});
