import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// --- Release-/Build-Metadaten zur Build-Zeit einfrieren -------------------
// Single Source of Truth für die Versionsnummer ist package.json; Git-Commit +
// Build-Datum bilden den "Patch"-/Build-Identifier (die Semver-Nummer bleibt über
// viele lokale Builds gleich, der Commit unterscheidet sie). Siehe src/version.ts.
const pkgVersion: string = JSON.parse(readFileSync("./package.json", "utf8")).version;

function git(cmd: string, fallback: string): string {
  try {
    return execSync(`git ${cmd}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || fallback;
  } catch {
    return fallback;
  }
}

const gitCommit = git("rev-parse --short HEAD", "unknown");
const gitBranch = git("rev-parse --abbrev-ref HEAD", "unknown");
const gitDirty = git("status --porcelain", "") !== "";
const buildDate = new Date().toISOString();

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  define: {
    __APP_VERSION__: JSON.stringify(pkgVersion),
    __GIT_COMMIT__: JSON.stringify(gitCommit),
    __GIT_BRANCH__: JSON.stringify(gitBranch),
    __GIT_DIRTY__: JSON.stringify(gitDirty),
    __BUILD_DATE__: JSON.stringify(buildDate),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
