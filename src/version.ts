/**
 * Release-/Versions-Logik (Single Source of Truth für die ANZEIGE).
 *
 * - Versionsnummer: SemVer aus package.json (via vite-`define` zur Build-Zeit injiziert).
 *   Geändert wird sie zentral mit `npm run version:set <x.y.z>` (hält package.json,
 *   sidecar/package.json, tauri.conf.json und Cargo.toml synchron).
 * - Channel: alles unter 1.0.0 gilt als "Pre-Release"; ein SemVer-Suffix wie
 *   `0.2.0-beta.1` wird als eigener Channel ("beta", "rc", …) erkannt.
 * - Build-Identifier ("Patch"): Git-Commit + Build-Datum — unterscheidet lokale Builds
 *   mit gleicher Versionsnummer. `dirty` markiert einen Build mit uncommitteten Änderungen.
 */

export type ReleaseChannel = "pre-release" | "release" | "beta" | "alpha" | "rc" | (string & {});

function channelFor(v: string): ReleaseChannel {
  const dash = v.indexOf("-");
  if (dash >= 0) {
    const tag = v.slice(dash + 1).split(".")[0];
    return (tag || "pre-release") as ReleaseChannel;
  }
  const major = Number(v.split(".")[0]);
  return Number.isFinite(major) && major >= 1 ? "release" : "pre-release";
}

const version = __APP_VERSION__;
const channel = channelFor(version);

export const RELEASE = {
  /** SemVer aus package.json, z.B. "0.1.0". */
  version,
  /** "pre-release" | "release" | "beta" | … (aus der Versionsnummer abgeleitet). */
  channel,
  /** true für alles außer dem stabilen "release"-Channel. */
  isPreRelease: channel !== "release",
  /** Kurzer Git-Commit-Hash dieses Builds (oder "unknown"). */
  commit: __GIT_COMMIT__,
  /** Branch, von dem gebaut wurde. */
  branch: __GIT_BRANCH__,
  /** true, wenn beim Build uncommittete Änderungen im Working-Tree lagen. */
  dirty: __GIT_DIRTY__,
  /** ISO-Zeitstempel des Builds. */
  buildDate: __BUILD_DATE__,
  /** Kompakt für Pills: "0.1.0 · f5f18d8" (mit "*" bei dirty). */
  get short(): string {
    return `${version} · ${this.commit}${this.dirty ? "*" : ""}`;
  },
  /** Mit Channel-Präfix: "v0.1.0 · pre-release". */
  get label(): string {
    return `v${version} · ${channel}`;
  },
} as const;

/** Build-Datum lokal lesbar (oder "—", falls unbekannt). */
export function buildDateLocal(): string {
  const t = Date.parse(RELEASE.buildDate);
  return Number.isNaN(t) ? "—" : new Date(t).toLocaleString();
}
