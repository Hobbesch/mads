/// <reference types="vite/client" />

// Build-Zeit-Konstanten, injiziert via vite.config.ts `define`. Siehe src/version.ts.
declare const __APP_VERSION__: string;
declare const __GIT_COMMIT__: string;
declare const __GIT_BRANCH__: string;
declare const __GIT_DIRTY__: boolean;
declare const __BUILD_DATE__: string;
