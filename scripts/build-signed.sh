#!/usr/bin/env bash
# Signierter (Developer ID) und — falls Apple-Credentials vorhanden — notarisierter
# + gestapelter macOS-Build von mads.
#
# Lädt die Credentials aus .env.notarize (gitignored) und ruft `tauri build`.
# Tauri notarisiert automatisch, sobald entweder APPLE_API_KEY/APPLE_API_ISSUER/
# APPLE_API_KEY_PATH oder APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID gesetzt sind.
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

if [ "$#" -gt 0 ]; then
  npm run tauri build -- "$@"
else
  npm run tauri build
fi
