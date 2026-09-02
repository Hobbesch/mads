// Build-Zeit-Konstanten, injiziert via scripts/build.mjs `define`. Siehe src/index.ts
// (checkBuildDrift) und src/vite-env.d.ts fürs identische Muster auf der Frontend-Seite.
declare const __SIDECAR_GIT_COMMIT__: string;
declare const __SIDECAR_GIT_DIRTY__: boolean;
