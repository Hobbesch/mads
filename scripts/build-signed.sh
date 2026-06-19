#!/usr/bin/env bash
# Signierter (Developer ID) und — falls Apple-Credentials vorhanden — notarisierter
# + gestapelter macOS-Build von mads.
#
# Lädt die Credentials aus .env.notarize (gitignored) und ruft `tauri build`.
# Tauri notarisiert/stapelt automatisch die .app; das .dmg notarisiert/stapelt
# dieses Skript danach nach (Tauri tut das für das DMG nicht).
#
# Nutzung:
#   npm run release:mac                 # alle macOS-Targets (app + dmg)
#   npm run release:mac -- --bundles app
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .env.notarize ]; then
  set -a
  # shellcheck disable=SC1091
  source .env.notarize
  set +a
  if [ -n "${APPLE_API_KEY:-}" ] || [ -n "${APPLE_ID:-}" ]; then
    echo "[release] .env.notarize geladen → Build wird signiert UND notarisiert."
  else
    echo "[release] .env.notarize geladen, aber keine Apple-Credentials gesetzt → nur signiert."
  fi
else
  echo "[release] HINWEIS: .env.notarize fehlt → Build wird signiert, aber NICHT notarisiert."
  echo "[release]          Kopiere .env.notarize.example → .env.notarize und trage die Credentials ein."
fi

# Sidecar bauen (tauri build baut nur das Frontend, nicht den Node-Sidecar).
echo "[release] baue Sidecar (esbuild)…"
npm run sidecar:build

if [ "$#" -gt 0 ]; then
  npm run tauri build -- "$@"
else
  npm run tauri build
fi

# --- DMG nachträglich notarisieren + stapeln (Tauri notarisiert nur die .app) ---
notarize_args=()
if [ -n "${APPLE_API_KEY:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ] && [ -n "${APPLE_API_KEY_PATH:-}" ]; then
  notarize_args=(--key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER")
elif [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
  notarize_args=(--apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID")
fi

if [ "${#notarize_args[@]}" -gt 0 ]; then
  shopt -s nullglob
  for dmg in src-tauri/target/release/bundle/dmg/*.dmg; do
    if xcrun stapler validate "$dmg" >/dev/null 2>&1; then
      echo "[release] DMG bereits gestapelt: $dmg"
    else
      echo "[release] notarisiere + stapele DMG: $dmg"
      xcrun notarytool submit "$dmg" "${notarize_args[@]}" --wait
      xcrun stapler staple "$dmg"
      xcrun stapler validate "$dmg"
    fi
  done
fi
